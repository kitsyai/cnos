package varrpc

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	cnos "github.com/kitsyai/cnos/packages/go"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// The Go suite is self-contained: it runs an in-process gRPC server speaking the same
// hand-written messages, so it never needs a Node process. Cross-toolchain compatibility is
// pinned separately, at the byte level, by wire_test.go.

type testServer struct {
	mu          sync.Mutex
	heads       map[string]*SnapshotBatch
	subscribers map[int]chan *SnapshotBatch
	nextSub     int
	// requiredToken, when set, makes the server reject calls without a matching bearer.
	requiredToken string
}

func newTestServer() *testServer {
	return &testServer{heads: map[string]*SnapshotBatch{}, subscribers: map[int]chan *SnapshotBatch{}}
}

func (server *testServer) authorize(ctx context.Context) error {
	server.mu.Lock()
	required := server.requiredToken
	server.mu.Unlock()

	if required == "" {
		return nil
	}

	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return status.Error(codes.Unauthenticated, "missing metadata")
	}
	for _, value := range md.Get("authorization") {
		if value == "Bearer "+required {
			return nil
		}
	}
	return status.Error(codes.Unauthenticated, "not authorized for this var scope")
}

// activate publishes a new head for a scope and pushes it to matching subscribers, mirroring
// the TypeScript engine's commit path.
func (server *testServer) activate(scope string, generation int64, revision string, values map[string]any) {
	encoded, err := json.Marshal(values)
	if err != nil {
		panic(err)
	}
	batch := &SnapshotBatch{
		Scope:       scope,
		Generation:  generation,
		Revision:    revision,
		EffectiveAt: "2026-07-20T00:00:00.000Z",
		ValuesJSON:  encoded,
	}

	server.mu.Lock()
	server.heads[scope] = batch
	channels := make([]chan *SnapshotBatch, 0, len(server.subscribers))
	for _, channel := range server.subscribers {
		channels = append(channels, channel)
	}
	server.mu.Unlock()

	for _, channel := range channels {
		select {
		case channel <- batch:
		default:
		}
	}
}

func (server *testServer) Pull(ctx context.Context, request *PullRequest) (*SnapshotBatch, error) {
	if err := server.authorize(ctx); err != nil {
		return nil, err
	}

	server.mu.Lock()
	head := server.heads[request.Scope]
	server.mu.Unlock()

	if head == nil {
		return &SnapshotBatch{Scope: request.Scope, NoHead: true}, nil
	}
	if request.KnownRevision != "" && request.KnownRevision == head.Revision {
		return &SnapshotBatch{
			Scope:       request.Scope,
			Generation:  head.Generation,
			Revision:    head.Revision,
			NotModified: true,
		}, nil
	}
	return head, nil
}

func (server *testServer) Subscribe(request *SubscribeRequest, stream VarServiceSubscribeServer) error {
	if err := server.authorize(stream.Context()); err != nil {
		return err
	}

	channel := make(chan *SnapshotBatch, 8)
	server.mu.Lock()
	id := server.nextSub
	server.nextSub++
	server.subscribers[id] = channel
	server.mu.Unlock()

	defer func() {
		server.mu.Lock()
		delete(server.subscribers, id)
		server.mu.Unlock()
	}()

	for {
		select {
		case <-stream.Context().Done():
			return stream.Context().Err()
		case batch := <-channel:
			matched := false
			for _, scope := range request.Scopes {
				if batch.Scope == scope || len(batch.Scope) > len(scope) && batch.Scope[:len(scope)+1] == scope+"." {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
			if err := stream.Send(batch); err != nil {
				return err
			}
		}
	}
}

type runningServer struct {
	target string
	stop   func()
}

// serveOn starts the test service. When listener is nil a fresh random port is chosen.
func serveOn(t *testing.T, service *testServer, listener net.Listener) *runningServer {
	t.Helper()

	if listener == nil {
		var err error
		listener, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
	}

	grpcServer := grpc.NewServer(grpc.ForceServerCodec(Codec()))
	RegisterVarServiceServer(grpcServer, service)

	go func() { _ = grpcServer.Serve(listener) }()

	return &runningServer{
		target: listener.Addr().String(),
		stop:   grpcServer.Stop,
	}
}

func newProvider(t *testing.T, target string, auth map[string]string, token string, configure ...Option) *Provider {
	t.Helper()

	def := cnos.VarSourceDef{Transport: "rpc", URL: target, Auth: auth}
	providerCtx := cnos.VarProviderContext{
		ResolveSecret: func(string) (string, error) { return token, nil },
	}

	provider, err := New(def, providerCtx, configure...)
	if err != nil {
		t.Fatalf("new provider: %v", err)
	}
	t.Cleanup(func() { _ = provider.Close() })
	return provider
}

func TestPullFreshNotModifiedAndNoHead(t *testing.T) {
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	provider := newProvider(t, server.target, nil, "")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// no_head → overlay fallback (http 404 no-head equivalent).
	result, err := provider.Pull(ctx, cnos.VarScope{Group: "agentic"}, "")
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if result.Status != cnos.VarPullNoHead {
		t.Fatalf("status: got %d, want VarPullNoHead", result.Status)
	}

	service.activate("agentic", 1, "sha256:aaa", map[string]any{
		"agentic.lanes.vinci": map[string]any{"enabled": true, "model_target_ref": "runtime-ref"},
	})

	// Fresh head.
	result, err = provider.Pull(ctx, cnos.VarScope{Group: "agentic"}, "")
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if result.Status != cnos.VarPullOK {
		t.Fatalf("status: got %d, want VarPullOK", result.Status)
	}
	if result.Generation != 1 || result.Revision != "sha256:aaa" {
		t.Fatalf("metadata: got generation=%d revision=%q", result.Generation, result.Revision)
	}
	document, ok := result.Values["agentic.lanes.vinci"].(map[string]any)
	if !ok || document["model_target_ref"] != "runtime-ref" {
		t.Fatalf("values: got %#v", result.Values)
	}

	// not_modified → keep cache (http 304 equivalent).
	result, err = provider.Pull(ctx, cnos.VarScope{Group: "agentic"}, "sha256:aaa")
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if result.Status != cnos.VarPullNotModified {
		t.Fatalf("status: got %d, want VarPullNotModified", result.Status)
	}
}

func TestPullBearerAuth(t *testing.T) {
	service := newTestServer()
	service.requiredToken = "workload-token-xyz"
	server := serveOn(t, service, nil)
	defer server.stop()

	service.activate("agentic", 1, "sha256:aaa", map[string]any{"agentic.enabled": true})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	bad := newProvider(t, server.target, map[string]string{"bearer": "secret.ops.token"}, "wrong-token")
	if _, err := bad.Pull(ctx, cnos.VarScope{Group: "agentic"}, ""); err == nil {
		t.Fatal("expected an authentication failure with the wrong bearer token")
	}

	good := newProvider(t, server.target, map[string]string{"bearer": "secret.ops.token"}, "workload-token-xyz")
	result, err := good.Pull(ctx, cnos.VarScope{Group: "agentic"}, "")
	if err != nil {
		t.Fatalf("pull with the correct token: %v", err)
	}
	if result.Status != cnos.VarPullOK {
		t.Fatalf("status: got %d, want VarPullOK", result.Status)
	}
}

func TestSubscribeDeliversActivations(t *testing.T) {
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	provider := newProvider(t, server.target, nil, "")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	received := make(chan cnos.VarBatchResult, 4)
	stop, err := provider.Subscribe(ctx, []cnos.VarScope{{Group: "agentic"}}, func(batch cnos.VarBatchResult) {
		received <- batch
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer stop()

	// Let the stream establish, then activate.
	time.Sleep(300 * time.Millisecond)
	service.activate("agentic", 2, "sha256:bbb", map[string]any{
		"agentic.lanes.vinci": map[string]any{"enabled": true, "model_target_ref": "pushed"},
	})

	select {
	case batch := <-received:
		if batch.Status != cnos.VarPullOK || batch.Generation != 2 {
			t.Fatalf("batch: %#v", batch)
		}
		document, ok := batch.Values["agentic.lanes.vinci"].(map[string]any)
		if !ok || document["model_target_ref"] != "pushed" {
			t.Fatalf("values: %#v", batch.Values)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for a pushed activation")
	}
}

func TestSubscribeReconnectsAfterServerRestart(t *testing.T) {
	service := newTestServer()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	target := listener.Addr().String()
	server := serveOn(t, service, listener)

	// Short backoff keeps the reconnect assertion quick without weakening it.
	provider := newProvider(t, target, nil, "", WithBackoff(50*time.Millisecond, 200*time.Millisecond))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	received := make(chan cnos.VarBatchResult, 4)
	stop, err := provider.Subscribe(ctx, []cnos.VarScope{{Group: "agentic"}}, func(batch cnos.VarBatchResult) {
		received <- batch
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer stop()

	time.Sleep(300 * time.Millisecond)

	// Drop the server, then bring a new one up on the SAME port.
	server.stop()
	time.Sleep(100 * time.Millisecond)

	restartListener, err := net.Listen("tcp", target)
	if err != nil {
		t.Fatalf("re-listen on %s: %v", target, err)
	}
	restarted := serveOn(t, service, restartListener)
	defer restarted.stop()

	// Keep activating until the reconnected stream delivers — the client is backing off.
	deadline := time.After(15 * time.Second)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	generation := int64(3)
	for {
		select {
		case batch := <-received:
			if batch.Status != cnos.VarPullOK {
				t.Fatalf("batch: %#v", batch)
			}
			return // reconnected and delivered
		case <-ticker.C:
			generation++
			service.activate("agentic", generation, fmt.Sprintf("sha256:%d", generation), map[string]any{
				"agentic.lanes.vinci": map[string]any{"enabled": true, "model_target_ref": "after-restart"},
			})
		case <-deadline:
			t.Fatal("subscription did not reconnect after the server restart")
		}
	}
}

func TestCloseCancelsSubscriptionsAndIsIdempotent(t *testing.T) {
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	def := cnos.VarSourceDef{Transport: "rpc", URL: server.target}
	provider, err := New(def, cnos.VarProviderContext{})
	if err != nil {
		t.Fatalf("new provider: %v", err)
	}

	if _, err := provider.Subscribe(context.Background(), []cnos.VarScope{{Group: "agentic"}}, func(cnos.VarBatchResult) {}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	time.Sleep(150 * time.Millisecond)

	if err := provider.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := provider.Close(); err != nil {
		t.Fatalf("close is not idempotent: %v", err)
	}

	// A pull after close must fail rather than silently hang.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := provider.Pull(ctx, cnos.VarScope{Group: "agentic"}, ""); err == nil {
		t.Fatal("expected pull on a closed provider to fail")
	}
}

func TestGrpcTargetStripsScheme(t *testing.T) {
	cases := map[string]string{
		"cnos-vars.internal:443":         "cnos-vars.internal:443",
		"https://cnos-vars.internal:443": "cnos-vars.internal:443",
		"grpc://127.0.0.1:8791/":         "127.0.0.1:8791",
	}
	for input, want := range cases {
		if got := grpcTarget(input); got != want {
			t.Errorf("grpcTarget(%q): got %q, want %q", input, got, want)
		}
	}
}
