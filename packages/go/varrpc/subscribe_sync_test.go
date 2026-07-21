package varrpc

import (
	"context"
	"encoding/json"
	"net"
	"sync/atomic"
	"testing"
	"time"

	cnos "github.com/kitsyai/cnos/packages/go"
)

// SELF-SYNCHRONIZING SUBSCRIBE (round-3 follow-up), Go half.
//
// Round-3 blocker 1 ("rpc reconnect never re-pulls subscribed scopes") was fixed on the CLIENT
// side. The server still registered its commit listener only AFTER authorization resolved, so a
// commit landing between the Subscribe request arriving and that registration completing reached
// neither the stream nor the resync pull. Losing a DEACTIVATION there leaves a consumer serving
// withdrawn policy with no poller to converge — subscribe-capable sources deliberately do not
// poll.
//
// The Go client needs no change to accept the new initial event: it is an ordinary
// batch / no_head message on the existing ingest path. These tests PROVE that rather than
// assuming it, and drive the authorization-window race deterministically via the test server's
// auth gate instead of hoping to hit a sub-millisecond window.

// gatedServer starts a test server whose authorize blocks until the returned release is called.
func gatedServer(t *testing.T, requiredToken string) (*testServer, *runningServer, func()) {
	t.Helper()

	service := newTestServer()
	service.authGate = make(chan struct{})
	service.requiredToken = requiredToken
	server := serveOn(t, service, nil)
	t.Cleanup(server.stop)

	released := false
	return service, server, func() {
		if !released {
			released = true
			close(service.authGate)
		}
	}
}

// waitFor polls until the predicate holds, or fails the test.
func waitFor(t *testing.T, what string, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestCommitInTheAuthorizeWindowIsBufferedAndDeliveredExactlyOnce(t *testing.T) {
	service, server, release := gatedServer(t, "")

	provider := newProvider(t, server.target, nil, "")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	received := make(chan cnos.VarBatchResult, 8)
	stop, err := provider.Subscribe(ctx, []cnos.VarScope{{Group: "agentic"}}, func(batch cnos.VarBatchResult) {
		received <- batch
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer stop()

	// The server is now inside its authorization window with the subscriber queue already
	// registered. Before the fix, the listener did not exist yet and this commit was dropped.
	waitFor(t, "the server to enter the authorize window", func() bool { return service.authWindowEntered() >= 1 })

	service.activate("agentic", 4, "sha256:in-window", map[string]any{
		"agentic.lanes.vinci": map[string]any{"enabled": true, "model_target_ref": "in-window"},
	})

	select {
	case batch := <-received:
		t.Fatalf("nothing may be written while authorization is pending, got %#v", batch)
	case <-time.After(200 * time.Millisecond):
	}

	release()

	select {
	case batch := <-received:
		if batch.Status != cnos.VarPullOK || batch.Revision != "sha256:in-window" {
			t.Fatalf("the commit made in the authorize window was lost or mangled: %#v", batch)
		}
		document, _ := batch.Values["agentic.lanes.vinci"].(map[string]any)
		if document["model_target_ref"] != "in-window" {
			t.Fatalf("values: %#v", batch.Values)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a commit landing in the authorize window was never delivered")
	}

	// EXACTLY once: the flushed buffer and the initial state carry the same revision, and the
	// initial state is deduplicated against the flush rather than repeated.
	select {
	case batch := <-received:
		t.Fatalf("the same revision was delivered twice: %#v", batch)
	case <-time.After(500 * time.Millisecond):
	}
}

func TestAuthorizationFailureTerminatesTheStreamAndBuffersNothing(t *testing.T) {
	service, server, release := gatedServer(t, "good-token")

	failures := make(chan bool, 8)
	def := cnos.VarSourceDef{Transport: "rpc", URL: server.target, Auth: map[string]string{"bearer": "secret.ops.token"}}
	providerCtx := cnos.VarProviderContext{ResolveSecret: func(string) (string, error) { return "wrong-token", nil }}
	provider, err := New(def, providerCtx, WithOnError(func(_ error, terminal bool, _ []string) {
		failures <- terminal
	}))
	if err != nil {
		t.Fatalf("new provider: %v", err)
	}
	t.Cleanup(func() { _ = provider.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	received := make(chan cnos.VarBatchResult, 8)
	stop, err := provider.Subscribe(ctx, []cnos.VarScope{{Group: "agentic"}}, func(batch cnos.VarBatchResult) {
		received <- batch
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer stop()

	waitFor(t, "the server to enter the authorize window", func() bool { return service.authWindowEntered() >= 1 })
	service.activate("agentic", 5, "sha256:refused", map[string]any{
		"agentic.lanes.vinci": map[string]any{"enabled": true, "model_target_ref": "refused"},
	})

	release()

	// Terminal, per the unchanged UNAUTHENTICATED policy — buffering does not weaken it.
	select {
	case terminal := <-failures:
		if !terminal {
			t.Fatal("an auth-rejected Subscribe must be TERMINAL")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("an auth-rejected Subscribe was never reported")
	}

	// And the buffered commit was discarded, never written to a refused identity.
	select {
	case batch := <-received:
		t.Fatalf("a refused subscription must write nothing, got %#v", batch)
	case <-time.After(500 * time.Millisecond):
	}
}

func TestFreshSubscribeImmediatelyReceivesTheCurrentHead(t *testing.T) {
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	service.activate("agentic", 3, "sha256:already-live", map[string]any{
		"agentic.lanes.vinci": map[string]any{"enabled": true, "model_target_ref": "already-live"},
	})

	provider := newProvider(t, server.target, nil, "")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	received := make(chan cnos.VarBatchResult, 8)
	stop, err := provider.Subscribe(ctx, []cnos.VarScope{{Group: "agentic"}}, func(batch cnos.VarBatchResult) {
		received <- batch
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer stop()

	// NOTHING is committed after the subscribe: this can only be the initial state event, and
	// the Go client accepts it as an ordinary batch with no special handling.
	select {
	case batch := <-received:
		if batch.Status != cnos.VarPullOK || batch.Generation != 3 || batch.Revision != "sha256:already-live" {
			t.Fatalf("initial event: %#v", batch)
		}
		document, _ := batch.Values["agentic.lanes.vinci"].(map[string]any)
		if document["model_target_ref"] != "already-live" {
			t.Fatalf("values: %#v", batch.Values)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("an accepted Subscribe never emitted the current head")
	}
}

func TestSubscribeToADeactivatedScopeImmediatelyReceivesNoHead(t *testing.T) {
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	service.activate("agentic", 1, "sha256:r1", map[string]any{"agentic.lanes.vinci": map[string]any{"enabled": true}})
	service.deactivate("agentic")

	provider := newProvider(t, server.target, nil, "")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	received := make(chan cnos.VarBatchResult, 8)
	stop, err := provider.Subscribe(ctx, []cnos.VarScope{{Group: "agentic"}}, func(batch cnos.VarBatchResult) {
		received <- batch
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer stop()

	select {
	case batch := <-received:
		if batch.Status != cnos.VarPullNoHead || batch.Scope != "agentic" {
			t.Fatalf("expected an immediate no_head for a deactivated scope, got %#v", batch)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a subscribe to a deactivated scope never emitted no_head")
	}
}

// streamOnlyFactory builds the rpc provider with the SDK's OnSubscriptionConnected resync seam
// REPLACED by a counter that pulls nothing. The SDK wires that seam itself
// (`variables.resyncSubscribedScopes`), so simply not setting it on our own context would not
// have neutralized anything — the reconnect pull would still have run and these tests would
// have passed no matter what the server did. The counter proves the reconnect happened while
// guaranteeing no pull was issued on its behalf.
func streamOnlyFactory(resyncs *int64) cnos.VarSourceProviderFactory {
	return cnos.VarSourceProviderFactory{
		Transport: Transport,
		Create: func(def cnos.VarSourceDef, providerCtx cnos.VarProviderContext) (cnos.VarSourceProvider, error) {
			providerCtx.OnSubscriptionConnected = func(_ []string, _ bool) {
				atomic.AddInt64(resyncs, 1)
			}
			return New(def, providerCtx)
		},
	}
}

// streamOnlyRuntime builds a full SDK runtime over an rpc source whose reconnect resync pull is
// neutralized, so any convergence observed came from the subscription stream ALONE. pollInterval
// is declared deliberately: a subscribe-capable source must IGNORE it (capability rule), so no
// poller can converge either.
func streamOnlyRuntime(t *testing.T, target string, resyncs *int64) *cnos.Runtime {
	t.Helper()

	projection := cnos.ServerProjection{
		Version:           1,
		Workspace:         "api",
		Profile:           "stage",
		ResolvedAt:        "2026-07-20T00:00:00Z",
		ConfigHash:        "hash",
		Values:            map[string]any{"value.flags.mode": "static-tier"},
		Derived:           map[string]cnos.DerivedFormula{},
		SecretRefs:        map[string]cnos.SecretReference{},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              cnos.ProjectionMeta{Workspace: "api", Profile: "stage", CnosVersion: "1.17.0"},
		VarSources:        map[string]cnos.VarSourceDef{"svc": {Transport: "rpc", URL: target, PollInterval: "20ms"}},
		Vars:              map[string]cnos.VarGroupDef{"flags": {Source: "svc", Mode: "prefetch"}},
		Schema:            map[string]cnos.VarKeyRule{"var.flags.mode": {Type: "string"}},
	}

	payload, err := json.Marshal(projection)
	if err != nil {
		t.Fatalf("marshal projection: %v", err)
	}

	runtime, err := cnos.LoadProjection(payload, cnos.Options{
		SecretHome:         t.TempDir(),
		Environment:        map[string]string{},
		VarSourceProviders: []cnos.VarSourceProviderFactory{streamOnlyFactory(resyncs)},
	})
	if err != nil {
		t.Fatalf("load projection: %v", err)
	}
	t.Cleanup(func() { _ = runtime.Close() })

	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("start vars: %v", err)
	}
	return runtime
}

// restartOnSamePort brings a fresh server up on the same address. The caller has already
// stopped the previous one and made whatever mutation the client must miss.
func restartOnSamePort(t *testing.T, service *testServer, target string) *runningServer {
	t.Helper()

	listener, err := net.Listen("tcp", target)
	if err != nil {
		t.Fatalf("re-listen on %s: %v", target, err)
	}
	restarted := serveOn(t, service, listener)
	t.Cleanup(restarted.stop)
	return restarted
}

func TestReconnectConvergesFromTheStreamAloneOnAnActivation(t *testing.T) {
	service := newTestServer()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	target := listener.Addr().String()
	server := serveOn(t, service, listener)

	service.activate("flags", 1, "sha256:before", map[string]any{"flags.mode": "before"})

	var resyncs int64
	runtime := streamOnlyRuntime(t, target, &resyncs)
	if value, _, _ := runtime.Var("flags.mode"); value != "before" {
		t.Fatalf("expected the pre-outage head, got %v", value)
	}

	time.Sleep(300 * time.Millisecond) // let the subscription establish

	// EXACTLY ONE mutation, entirely while the client is disconnected.
	server.stop()
	time.Sleep(100 * time.Millisecond)
	service.activate("flags", 2, "sha256:during-outage", map[string]any{"flags.mode": "during-outage"})

	restartOnSamePort(t, service, target)

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if value, _, _ := runtime.Var("flags.mode"); value == "during-outage" {
			if atomic.LoadInt64(&resyncs) == 0 {
				t.Fatal("the subscription never reconnected — the test proved nothing")
			}
			return // converged with no resync pull and no poller anywhere
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("an activation made during the outage never converged from the stream alone")
}

func TestReconnectConvergesFromTheStreamAloneOnADeactivation(t *testing.T) {
	service := newTestServer()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	target := listener.Addr().String()
	server := serveOn(t, service, listener)

	service.activate("flags", 1, "sha256:before", map[string]any{"flags.mode": "runtime-tier"})

	var resyncs int64
	runtime := streamOnlyRuntime(t, target, &resyncs)
	if value, _, _ := runtime.Var("flags.mode"); value != "runtime-tier" {
		t.Fatalf("expected the runtime tier, got %v", value)
	}

	time.Sleep(300 * time.Millisecond)

	// The worst case, and the one with NO other path to convergence: a withdrawal the client
	// never hears about, on a source that runs no poller. EXACTLY ONE mutation.
	server.stop()
	time.Sleep(100 * time.Millisecond)
	service.deactivate("flags")

	restartOnSamePort(t, service, target)

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if value, ok, _ := runtime.Var("flags.mode"); ok && value == "static-tier" {
			snapshot, _ := runtime.VarSnapshot("flags.mode")
			if snapshot.Source != cnos.VarSourceStatic {
				t.Fatalf("snapshot source after the missed deactivation: %#v", snapshot)
			}
			if atomic.LoadInt64(&resyncs) == 0 {
				t.Fatal("the subscription never reconnected — the test proved nothing")
			}
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("a deactivation made during the outage never converged from the stream alone")
}

func TestInitialEventRepeatingAKnownRevisionDoesNotFireWatchers(t *testing.T) {
	service := newTestServer()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	target := listener.Addr().String()
	server := serveOn(t, service, listener)

	service.activate("flags", 1, "sha256:stable", map[string]any{"flags.mode": "stable"})

	var resyncs int64
	runtime := streamOnlyRuntime(t, target, &resyncs)
	if value, _, _ := runtime.Var("flags.mode"); value != "stable" {
		t.Fatalf("expected the head, got %v", value)
	}

	fires := make(chan any, 16)
	unwatch := runtime.Watch("var.flags.mode", func(next, _ cnos.Snapshot) { fires <- next.Value })
	defer unwatch()

	time.Sleep(300 * time.Millisecond)

	// NOTHING is mutated across the restart, so the reconnect's initial event necessarily
	// carries the revision already applied.
	server.stop()
	time.Sleep(100 * time.Millisecond)
	restartOnSamePort(t, service, target)
	time.Sleep(1500 * time.Millisecond)

	// The store gates dispatch on the content-addressed revision, so a repeated revision is not
	// a change and must wake nobody.
	select {
	case value := <-fires:
		t.Fatalf("an initial event repeating a known revision fired a watcher with %#v", value)
	default:
	}

	// Proof the stream and the watcher were live the whole time: a REAL change still fires.
	service.activate("flags", 2, "sha256:changed", map[string]any{"flags.mode": "changed"})

	select {
	case value := <-fires:
		if value != "changed" {
			t.Fatalf("watcher fired with %#v", value)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("a real change never reached the watcher — the stream was not live")
	}
}
