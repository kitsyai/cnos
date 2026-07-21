package varrpc

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	cnos "github.com/kitsyai/cnos/packages/go"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// newProviderReporting builds a provider whose SDK-side OnSubscriptionError seam is
// observable, so a test can assert that failures reach the runtime (and thus VarStatus()).
func newProviderReporting(
	t *testing.T,
	target string,
	auth map[string]string,
	token string,
	onSubscriptionError func(err error, terminal bool, scopes []string),
	configure ...Option,
) *Provider {
	t.Helper()

	def := cnos.VarSourceDef{Transport: "rpc", URL: target, Auth: auth}
	providerCtx := cnos.VarProviderContext{
		ResolveSecret:       func(string) (string, error) { return token, nil },
		OnSubscriptionError: onSubscriptionError,
	}

	provider, err := New(def, providerCtx, configure...)
	if err != nil {
		t.Fatalf("new provider: %v", err)
	}
	t.Cleanup(func() { _ = provider.Close() })
	return provider
}

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

// deadTarget returns a loopback address that is guaranteed to refuse connections: it binds
// an ephemeral port, records it, then closes the listener.
//
// Do NOT hardcode a low port (127.0.0.1:1) for this. Under WSL2 the localhost forwarding shim
// swallows connections to low ports — they hang until timeout instead of returning
// ECONNREFUSED, so a "nothing is listening" test blocks inside the RPC and never observes the
// transport failure it is asserting on.
func deadTarget(t *testing.T) string {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve dead port: %v", err)
	}
	target := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatalf("close dead port: %v", err)
	}

	return target
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

func TestSubscribeAuthFailureIsTerminalAndReported(t *testing.T) {
	// W5d/D1+D2 CANONICAL (both SDKs): an UNAUTHENTICATED / PERMISSION_DENIED Subscribe is
	// TERMINAL — the provider does not reconnect (retrying with the same credentials can only
	// repeat the refusal) and it REPORTS the failure through the observable seams instead of
	// dying quietly (Node) or hammering forever (Go, previously).
	service := newTestServer()
	service.requiredToken = "correct-token"
	counter := &authCounter{testServer: service}

	server := serveOnCounting(t, counter)
	defer server.stop()

	var mu sync.Mutex
	var terminalErrors []error
	var sdkTerminal int

	provider := newProviderReporting(t, server.target, map[string]string{"bearer": "secret.ops.token"}, "wrong-token",
		func(err error, terminal bool, scopes []string) {
			mu.Lock()
			defer mu.Unlock()
			if terminal {
				sdkTerminal++
			}
		},
		WithBackoff(20*time.Millisecond, 60*time.Millisecond),
		WithOnError(func(err error, terminal bool, scopes []string) {
			mu.Lock()
			defer mu.Unlock()
			if terminal {
				terminalErrors = append(terminalErrors, err)
			}
		}),
	)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	delivered := make(chan cnos.VarBatchResult, 4)
	stop, err := provider.Subscribe(ctx, []cnos.VarScope{{Group: "agentic"}}, func(batch cnos.VarBatchResult) {
		delivered <- batch
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer stop()

	// The failure is reported promptly through BOTH seams.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		reported := len(terminalErrors) > 0 && sdkTerminal > 0
		mu.Unlock()
		if reported {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	mu.Lock()
	if len(terminalErrors) == 0 {
		mu.Unlock()
		t.Fatalf("an auth-rejected subscription must report a TERMINAL error to onError")
	}
	if status.Code(terminalErrors[0]) != codes.Unauthenticated {
		mu.Unlock()
		t.Fatalf("expected an UNAUTHENTICATED terminal error, got %v", terminalErrors[0])
	}
	if sdkTerminal == 0 {
		mu.Unlock()
		t.Fatalf("the terminal failure must also reach the SDK OnSubscriptionError seam")
	}
	mu.Unlock()

	// And it does NOT reconnect: the attempt count settles at one.
	settled := atomic.LoadInt64(&counter.subscribeAttempts)
	time.Sleep(500 * time.Millisecond)
	if grew := atomic.LoadInt64(&counter.subscribeAttempts) - settled; grew != 0 {
		t.Fatalf("a terminal auth failure must not reconnect, saw %d further attempts", grew)
	}
	if attempts := atomic.LoadInt64(&counter.subscribeAttempts); attempts != 1 {
		t.Fatalf("expected exactly one Subscribe attempt, got %d", attempts)
	}

	select {
	case batch := <-delivered:
		t.Fatalf("unexpected delivery on an unauthorized subscription: %#v", batch)
	default:
	}
}

func TestSubscribeRetriesAreBoundedByTheFailureCap(t *testing.T) {
	// W5d/D2 CANONICAL: transport failures stay retryable, but BOUNDED. After
	// maxFailures consecutive failures the subscription goes terminal instead of
	// reconnecting forever.
	var mu sync.Mutex
	var retrying, terminal int

	// Nothing is listening on this target, so every attempt fails at the transport layer.
	provider := newProviderReporting(t, deadTarget(t), nil, "",
		nil,
		WithBackoff(time.Millisecond, 2*time.Millisecond),
		WithMaxSubscribeFailures(3),
		WithOnError(func(err error, isTerminal bool, scopes []string) {
			mu.Lock()
			defer mu.Unlock()
			if isTerminal {
				terminal++
			} else {
				retrying++
			}
		}),
	)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stop, err := provider.Subscribe(ctx, []cnos.VarScope{{Group: "agentic"}}, func(cnos.VarBatchResult) {})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer stop()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		done := terminal > 0
		mu.Unlock()
		if done {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if terminal != 1 {
		t.Fatalf("expected exactly one terminal report after the cap, got %d", terminal)
	}
	if retrying != 2 {
		t.Fatalf("expected 2 retryable reports before the cap of 3, got %d", retrying)
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
	provider := newProvider(t, deadTarget(t), nil, "")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if _, err := provider.Pull(ctx, cnos.VarScope{Group: "agentic"}, ""); err == nil {
		t.Fatalf("expected a Pull against a dead target to fail")
	}
}

func TestPullInt64GenerationAtTheSafeBoundary(t *testing.T) {
	t.Parallel()
	// Go carries `generation` as a native int64, so values beyond 2^53 survive intact here.
	// The Node provider cannot represent them and now REJECTS such a batch outright
	// (W5d/D5) rather than silently rounding it — see packages/var-rpc/src/client.ts.
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
