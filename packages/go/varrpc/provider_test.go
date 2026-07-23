package varrpc

import (
	"context"
	"encoding/json"
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
	// authGate, when non-nil, blocks every authorize call until it is closed. It exists to
	// drive the authorization-window race DETERMINISTICALLY instead of hoping to hit a
	// sub-millisecond window. authEntered counts calls that have reached the block.
	authGate    chan struct{}
	authEntered int
	// suppressInitialEvent makes Subscribe behave like a server PREDATING the
	// self-synchronizing change: future commits only, no initial state event. The client-side
	// reconnect resync pull is retained precisely to cover such a server, so the resync tests
	// set this to keep isolating the pull rather than being satisfied by the initial event.
	suppressInitialEvent bool
}

func newTestServer() *testServer {
	return &testServer{heads: map[string]*SnapshotBatch{}, subscribers: map[int]chan *SnapshotBatch{}}
}

func (server *testServer) authorize(ctx context.Context) error {
	server.mu.Lock()
	required := server.requiredToken
	gate := server.authGate
	if gate != nil {
		server.authEntered++
	}
	server.mu.Unlock()

	// Blocking happens OUTSIDE the lock: commits must keep flowing (and buffering) while a
	// subscription sits in its authorization window.
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}

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

// authWindowEntered reports how many authorize calls are currently blocked on the gate.
func (server *testServer) authWindowEntered() int {
	server.mu.Lock()
	defer server.mu.Unlock()
	return server.authEntered
}

// push fans a committed batch out to every registered subscriber. It is called with server.mu
// HELD, so the head map and the subscriber queues advance atomically together — the Go
// equivalent of the TypeScript server's single-threaded commit path, and what lets Subscribe
// drain its buffer and read the current head without a commit interleaving between the two.
// Sends are non-blocking; the queues are sized well above anything the suite commits.
func (server *testServer) pushLocked(batch *SnapshotBatch) {
	for _, channel := range server.subscribers {
		select {
		case channel <- batch:
		default:
		}
	}
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
	defer server.mu.Unlock()
	server.heads[scope] = batch
	server.pushLocked(batch)
}

// scopeMatches mirrors the server-side prefix rule: a subscription to `g` receives commits on
// `g` and on `g.<anything>`, but never on a sibling that merely shares a string prefix.
func scopeMatches(subscribed []string, committed string) bool {
	for _, scope := range subscribed {
		if committed == scope || (len(committed) > len(scope) && committed[:len(scope)+1] == scope+".") {
			return true
		}
	}
	return false
}

// batchIdentity is the dedup key for "the same state twice in a row": the content-addressed
// revision, or a sentinel for no_head.
func batchIdentity(batch *SnapshotBatch) string {
	if batch.NoHead {
		return "\x00no-head"
	}
	return batch.Revision
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

// Subscribe mirrors the SELF-SYNCHRONIZING contract of the TypeScript server (the only real
// server implementation), so the Go CLIENT is exercised against the protocol it will actually
// meet:
//
//  1. the subscriber queue is registered BEFORE authorization, so commits landing in the
//     authorization window are buffered rather than lost;
//  2. a refused subscription discards that buffer and terminates, having sent nothing;
//  3. an accepted subscription emits the CURRENT STATE first — each requested scope's head, or
//     a no_head batch — deduplicated against the flushed buffer by revision.
func (server *testServer) Subscribe(request *SubscribeRequest, stream VarServiceSubscribeServer) error {
	channel := make(chan *SnapshotBatch, 64)
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

	if err := server.authorize(stream.Context()); err != nil {
		// The buffered commits belong to an identity the server just refused: they go with the
		// queue, unsent.
		return err
	}

	lastSent := map[string]string{}
	send := func(batch *SnapshotBatch) error {
		lastSent[batch.Scope] = batchIdentity(batch)
		return stream.Send(batch)
	}

	// Flush the authorization-window buffer and snapshot the current heads under ONE lock hold,
	// so no commit can interleave between the two and be sent twice or not at all.
	server.mu.Lock()
	legacy := server.suppressInitialEvent
	buffered := make([]*SnapshotBatch, 0, len(channel))
drain:
	for {
		select {
		case batch := <-channel:
			if scopeMatches(request.Scopes, batch.Scope) {
				buffered = append(buffered, batch)
			}
		default:
			break drain
		}
	}
	initial := make([]*SnapshotBatch, 0, len(request.Scopes))
	if !legacy {
		for _, scope := range request.Scopes {
			if head := server.heads[scope]; head != nil {
				initial = append(initial, head)
			} else {
				initial = append(initial, &SnapshotBatch{Scope: scope, NoHead: true})
			}
		}
	}
	server.mu.Unlock()

	for _, batch := range buffered {
		if err := send(batch); err != nil {
			return err
		}
	}

	// The heads were read AFTER the buffer, so they already reflect every flushed commit;
	// re-sending an identical revision would only be noise on the wire.
	for _, batch := range initial {
		if lastSent[batch.Scope] == batchIdentity(batch) {
			continue
		}
		if err := send(batch); err != nil {
			return err
		}
	}

	for {
		select {
		case <-stream.Context().Done():
			return stream.Context().Err()
		case batch := <-channel:
			if !scopeMatches(request.Scopes, batch.Scope) {
				continue
			}
			if err := send(batch); err != nil {
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

// awaitInitialNoHead asserts the SELF-SYNCHRONIZING contract: an accepted Subscribe always
// emits the current state as its first event, which for a scope with no active head is a
// no_head batch. The Go client needs no special handling for it — it is an ordinary event.
func awaitInitialNoHead(t *testing.T, received <-chan cnos.VarBatchResult, scope string) {
	t.Helper()
	select {
	case batch := <-received:
		if batch.Status != cnos.VarPullNoHead || batch.Scope != scope {
			t.Fatalf("expected an initial no_head event for %q, got %#v", scope, batch)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("an accepted Subscribe never emitted its initial event for %q", scope)
	}
}

// awaitStatus drains events until one carrying `want` arrives. Used where a reconnect's own
// initial event may be interleaved with the event under test.
func awaitStatus(t *testing.T, received <-chan cnos.VarBatchResult, want int, timeout time.Duration) cnos.VarBatchResult {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case batch := <-received:
			if batch.Status == want {
				return batch
			}
		case <-deadline:
			t.Fatalf("timed out waiting for a batch with status %v", want)
		}
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

	// The subscribe itself yields the current state (no head yet), then the activation follows.
	awaitInitialNoHead(t, received, "agentic")
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

	// Short backoff keeps the reconnect assertion quick without weakening it. The failure cap
	// is raised because the equal-jitter band (delay in [next/2, next]) retries roughly twice
	// as fast as the old additive jitter — a test outage must not exhaust the cap and go
	// terminal before the server is back.
	provider := newProvider(t, target, nil, "", WithBackoff(50*time.Millisecond, 200*time.Millisecond), WithMaxSubscribeFailures(1000))
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

	// Round 3: the old version of this test kept activating until SOMETHING landed, which
	// could not distinguish a reconnected stream from a working resync — and masked the fact
	// that neither existed. Exactly ONE activation happens, and it happens BEFORE the client
	// can possibly have reconnected, so only a live stream carrying a later commit or a resync
	// can satisfy it. Here the stream itself is under test: the single post-restart activation
	// is published once the client has demonstrably reconnected.
	//
	// Convergence for a mutation made DURING the outage is covered by resync_test.go.
	waitForReconnect(t, service)

	service.activate("agentic", 9, "sha256:after-restart", map[string]any{
		"agentic.lanes.vinci": map[string]any{"enabled": true, "model_target_ref": "after-restart"},
	})

	// Both connects emit their own initial no_head event (nothing was ever activated before the
	// restart), so drain to the activation under test.
	batch := awaitStatus(t, received, cnos.VarPullOK, 15*time.Second)
	document, _ := batch.Values["agentic.lanes.vinci"].(map[string]any)
	if document["model_target_ref"] != "after-restart" {
		t.Fatalf("values: %#v", batch.Values)
	}
}

// waitForReconnect blocks until the test server has a live subscriber again, i.e. the client's
// Subscribe stream has actually been re-established.
func waitForReconnect(t *testing.T, service *testServer) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		service.mu.Lock()
		subscribers := len(service.subscribers)
		service.mu.Unlock()
		if subscribers > 0 {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("subscription did not reconnect after the server restart")
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
