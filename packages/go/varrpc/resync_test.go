package varrpc

import (
	"context"
	"encoding/json"
	"net"
	"sync"
	"testing"
	"time"

	cnos "github.com/kitsyai/cnos/packages/go"
)

// Review round 3, BLOCKER 1. The ADR promises "on reconnect, re-pull subscribed scopes with
// known revisions to converge". Neither SDK did it: the client only reopened the stream, and the
// server forwards FUTURE commits only — so a mutation made during the outage was lost
// permanently. Since round 2 made deactivation a real state change, a missed deactivation means
// serving withdrawn policy forever, and an rpc source has no poller to recover with.
//
// Both tests below mutate EXACTLY ONCE, while the server is down, and mutate nothing after the
// reconnect. The old "keep activating until something lands" loop could not fail here.

// newResyncProvider builds a provider wired the way the SDK wires one: OnSubscriptionConnected
// re-pulls every subscribed scope and routes the result through the same onBatch callback the
// stream uses. `connects` counts (re)connects so the test can wait on a real reconnect.
func newResyncProvider(
	t *testing.T,
	target string,
	onBatch func(cnos.VarBatchResult),
	connects *int64,
	mu *sync.Mutex,
	configure ...Option,
) *Provider {
	t.Helper()

	var provider *Provider
	def := cnos.VarSourceDef{Transport: "rpc", URL: target}
	providerCtx := cnos.VarProviderContext{
		ResolveSecret: func(string) (string, error) { return "", nil },
		OnSubscriptionConnected: func(scopes []string, reconnect bool) {
			mu.Lock()
			*connects++
			mu.Unlock()

			if !reconnect {
				// First connect: the caller prefetched, so nothing to converge yet.
				return
			}
			for _, scope := range scopes {
				go func(target string) {
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					result, err := provider.Pull(ctx, cnos.VarScope{Group: target}, "")
					if err != nil {
						return
					}
					onBatch(result)
				}(scope)
			}
		},
	}

	created, err := New(def, providerCtx, configure...)
	if err != nil {
		t.Fatalf("new provider: %v", err)
	}
	provider = created
	t.Cleanup(func() { _ = provider.Close() })
	return provider
}

func TestSubscribeReconnectResyncsAMissedActivation(t *testing.T) {
	service := newTestServer()
	// Isolate the CLIENT-side resync pull: behave like a server predating the
	// self-synchronizing Subscribe, so convergence below can only have come from the pull.
	service.suppressInitialEvent = true

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	target := listener.Addr().String()
	server := serveOn(t, service, listener)

	received := make(chan cnos.VarBatchResult, 8)
	var mu sync.Mutex
	var connects int64

	provider := newResyncProvider(t, target, func(batch cnos.VarBatchResult) { received <- batch },
		&connects, &mu, WithBackoff(50*time.Millisecond, 200*time.Millisecond), WithMaxSubscribeFailures(1000))

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	stop, err := provider.Subscribe(ctx, []cnos.VarScope{{Group: "agentic"}}, func(batch cnos.VarBatchResult) {
		received <- batch
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer stop()

	time.Sleep(300 * time.Millisecond)

	// Drop the server. EXACTLY ONE mutation happens while it is down.
	server.stop()
	time.Sleep(100 * time.Millisecond)
	service.activate("agentic", 7, "sha256:during-outage", map[string]any{
		"agentic.lanes.vinci": map[string]any{"enabled": true, "model_target_ref": "during-outage"},
	})

	restartListener, err := net.Listen("tcp", target)
	if err != nil {
		t.Fatalf("re-listen on %s: %v", target, err)
	}
	restarted := serveOn(t, service, restartListener)
	defer restarted.stop()

	deadline := time.After(20 * time.Second)
	for {
		select {
		case batch := <-received:
			if batch.Status != cnos.VarPullOK {
				continue
			}
			document, _ := batch.Values["agentic.lanes.vinci"].(map[string]any)
			if document["model_target_ref"] == "during-outage" {
				return // converged with NO post-reconnect mutation
			}
		case <-deadline:
			t.Fatal("the reconnect never re-pulled: an activation made during the outage was lost")
		}
	}
}

func TestSubscribeReconnectResyncsAMissedDeactivation(t *testing.T) {
	service := newTestServer()
	// Isolate the CLIENT-side resync pull: behave like a server predating the
	// self-synchronizing Subscribe, so convergence below can only have come from the pull.
	service.suppressInitialEvent = true
	service.activate("agentic", 1, "sha256:before", map[string]any{
		"agentic.lanes.vinci": map[string]any{"enabled": true, "model_target_ref": "before"},
	})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	target := listener.Addr().String()
	server := serveOn(t, service, listener)

	received := make(chan cnos.VarBatchResult, 8)
	var mu sync.Mutex
	var connects int64

	provider := newResyncProvider(t, target, func(batch cnos.VarBatchResult) { received <- batch },
		&connects, &mu, WithBackoff(50*time.Millisecond, 200*time.Millisecond), WithMaxSubscribeFailures(1000))

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	stop, err := provider.Subscribe(ctx, []cnos.VarScope{{Group: "agentic"}}, func(batch cnos.VarBatchResult) {
		received <- batch
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer stop()

	time.Sleep(300 * time.Millisecond)

	// The worst case: a WITHDRAWAL the client never hears about. Exactly one mutation.
	server.stop()
	time.Sleep(100 * time.Millisecond)
	service.deactivate("agentic")

	restartListener, err := net.Listen("tcp", target)
	if err != nil {
		t.Fatalf("re-listen on %s: %v", target, err)
	}
	restarted := serveOn(t, service, restartListener)
	defer restarted.stop()

	deadline := time.After(20 * time.Second)
	for {
		select {
		case batch := <-received:
			if batch.Status == cnos.VarPullNoHead {
				return // the deactivation converged with NO post-reconnect mutation
			}
		case <-deadline:
			t.Fatal("the reconnect never re-pulled: a deactivation made during the outage was lost forever")
		}
	}
}

// TestRpcReconnectResyncRestoresStaticTierEndToEnd drives the whole chain through the real SDK:
// activate -> the runtime tier serves -> the connection drops -> the authority deactivates while
// the client is disconnected -> on reconnect the SDK's own resync pull restores the static tier.
// No poller exists anywhere in this picture (an rpc source ignores pollInterval by the
// capability rule), so only the resync can produce the fallback.
func TestRpcReconnectResyncRestoresStaticTierEndToEnd(t *testing.T) {
	service := newTestServer()
	// Isolate the CLIENT-side resync pull: behave like a server predating the
	// self-synchronizing Subscribe, so convergence below can only have come from the pull.
	service.suppressInitialEvent = true
	service.activate("flags", 1, "sha256:r1", map[string]any{"flags.mode": "runtime-tier"})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	target := listener.Addr().String()
	server := serveOn(t, service, listener)

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
		VarSources:        map[string]cnos.VarSourceDef{"svc": {Transport: "rpc", URL: target}},
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
		VarSourceProviders: []cnos.VarSourceProviderFactory{Factory(WithBackoff(50*time.Millisecond, 200*time.Millisecond), WithMaxSubscribeFailures(1000))},
	})
	if err != nil {
		t.Fatalf("load projection: %v", err)
	}
	defer runtime.Close()

	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("start vars: %v", err)
	}
	if value, _, _ := runtime.Var("flags.mode"); value != "runtime-tier" {
		t.Fatalf("expected the runtime tier after activation, got %v", value)
	}

	time.Sleep(300 * time.Millisecond) // let the subscription establish

	// Down, ONE deactivation, back up. Nothing is mutated after the restart.
	server.stop()
	time.Sleep(100 * time.Millisecond)
	service.deactivate("flags")

	restartListener, err := net.Listen("tcp", target)
	if err != nil {
		t.Fatalf("re-listen on %s: %v", target, err)
	}
	restarted := serveOn(t, service, restartListener)
	defer restarted.stop()

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if value, ok, _ := runtime.Var("flags.mode"); ok && value == "static-tier" {
			snapshot, _ := runtime.VarSnapshot("flags.mode")
			if snapshot.Source != cnos.VarSourceStatic {
				t.Fatalf("snapshot source after the resynced deactivation: %#v", snapshot)
			}
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("a deactivation missed during the outage was never resynced on reconnect")
}
