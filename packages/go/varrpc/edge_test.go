package varrpc

import (
	"context"
	"net"
	"sync/atomic"
	"testing"
	"time"

	cnos "github.com/kitsyai/cnos/packages/go"
	"google.golang.org/grpc"
)

// serveOnCounting mirrors serveOn but accepts any VarServiceServer implementation so a
// test can wrap the service and observe call counts.
func serveOnCounting(t *testing.T, service VarServiceServer) *runningServer {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	grpcServer := grpc.NewServer(grpc.ForceServerCodec(Codec()))
	RegisterVarServiceServer(grpcServer, service)
	go func() { _ = grpcServer.Serve(listener) }()

	return &runningServer{target: listener.Addr().String(), stop: grpcServer.Stop}
}

// W5b test hardening for the Go rpc transport: Subscribe failure policy, scope
// matching, and lifecycle edges. Tests named "Pinned"/"Divergence" encode current
// behavior that the design doc left unspecified or where Go and Node differ.

// countingServer wraps testServer's authorize path so a test can observe how many
// Subscribe attempts the client makes.
type authCounter struct {
	*testServer
	subscribeAttempts int64
}

func (server *authCounter) Subscribe(request *SubscribeRequest, stream VarServiceSubscribeServer) error {
	atomic.AddInt64(&server.subscribeAttempts, 1)
	return server.testServer.Subscribe(request, stream)
}

func TestSubscribePinnedAuthFailureRetriesForever(t *testing.T) {
	// DIVERGENCE + DEFECT-PIN: the Go provider's subscribeLoop treats an UNAUTHENTICATED
	// stream exactly like any other stream end — it backs off and reconnects, forever, with
	// no attempt cap and no terminal-error classification. (The Node provider has the
	// opposite bug: it never retries an auth-rejected Subscribe at all.) Neither SDK
	// surfaces the failure to the consumer. Pinned — see the W5b report.
	service := newTestServer()
	service.requiredToken = "correct-token"
	counter := &authCounter{testServer: service}

	server := serveOnCounting(t, counter)
	defer server.stop()

	provider := newProvider(t, server.target, map[string]string{"bearer": "secret.ops.token"}, "wrong-token",
		WithBackoff(20*time.Millisecond, 60*time.Millisecond))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	delivered := make(chan cnos.VarBatchResult, 4)
	stop, err := provider.Subscribe(ctx, []cnos.VarScope{{Group: "agentic"}}, func(batch cnos.VarBatchResult) {
		delivered <- batch
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	// Condition-poll: the retry loop must drive the attempt count well past one.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && atomic.LoadInt64(&counter.subscribeAttempts) < 3 {
		time.Sleep(10 * time.Millisecond)
	}
	attempts := atomic.LoadInt64(&counter.subscribeAttempts)
	if attempts < 3 {
		t.Fatalf("expected the auth-rejected subscription to keep retrying, saw %d attempts", attempts)
	}

	// Nothing was ever delivered, and no error reached the caller.
	select {
	case batch := <-delivered:
		t.Fatalf("unexpected delivery on an unauthorized subscription: %#v", batch)
	default:
	}

	// Cancelling stops the loop for good.
	stop()
	settled := atomic.LoadInt64(&counter.subscribeAttempts)
	time.Sleep(300 * time.Millisecond)
	if grew := atomic.LoadInt64(&counter.subscribeAttempts) - settled; grew > 1 {
		t.Fatalf("retry loop kept running %d attempts after stop()", grew)
	}
}

func TestSubscribeStopIsIdempotentAndSafeAfterClose(t *testing.T) {
	t.Parallel()
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	provider := newProvider(t, server.target, nil, "", WithBackoff(20*time.Millisecond, 60*time.Millisecond))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stop, err := provider.Subscribe(ctx, []cnos.VarScope{{Group: "agentic"}}, func(cnos.VarBatchResult) {})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	stop()
	stop() // idempotent
	if err := provider.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	stop() // still safe after Close
}

func TestSubscribeWithNoUsableScopesIsANoOp(t *testing.T) {
	t.Parallel()
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	provider := newProvider(t, server.target, nil, "")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Empty slice and scopes that produce an empty scope string both short-circuit.
	for _, scopes := range [][]cnos.VarScope{{}, {{}}} {
		stop, err := provider.Subscribe(ctx, scopes, func(cnos.VarBatchResult) {
			t.Fatalf("callback must never fire for an empty scope set")
		})
		if err != nil {
			t.Fatalf("subscribe: %v", err)
		}
		stop()
	}
}

func TestSubscribeAfterCloseReturnsAnError(t *testing.T) {
	t.Parallel()
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	provider := newProvider(t, server.target, nil, "")
	if err := provider.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	if _, err := provider.Subscribe(context.Background(), []cnos.VarScope{{Group: "agentic"}}, func(cnos.VarBatchResult) {}); err == nil {
		t.Fatalf("expected Subscribe on a closed provider to error")
	}
}

func TestPullAgainstUnreachableTargetFailsFast(t *testing.T) {
	t.Parallel()
	provider := newProvider(t, "127.0.0.1:1", nil, "")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if _, err := provider.Pull(ctx, cnos.VarScope{Group: "agentic"}, ""); err == nil {
		t.Fatalf("expected a Pull against a dead target to fail")
	}
}

func TestPullInt64GenerationAtTheSafeBoundary(t *testing.T) {
	t.Parallel()
	// Go carries `generation` as a native int64, so values that the Node provider would round
	// (it converts the decimal string with Number()) survive intact here. Pinned as the
	// cross-SDK asymmetry — see the W5b report.
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	const beyondJSSafe = int64(9007199254740993) // 2^53 + 1
	service.activate("agentic", beyondJSSafe, "sha256:big", map[string]any{"agentic.k": 1})

	provider := newProvider(t, server.target, nil, "")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	result, err := provider.Pull(ctx, cnos.VarScope{Group: "agentic"}, "")
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if result.Generation != beyondJSSafe {
		t.Fatalf("int64 generation lost precision: got %d, want %d", result.Generation, beyondJSSafe)
	}
}
