package varrpc

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	cnos "github.com/kitsyai/cnos/packages/go"
)

// Review round 2, BLOCKER 1 (rpc half): a pushed `no_head` is a DEACTIVATION and must reach the
// SDK. The provider used to drop it, and because a subscribe-capable source runs no poller, an
// rpc consumer served the deactivated revision indefinitely with no pull to converge on.

// deactivate drops a scope's head and pushes the no_head message the TypeScript rpc server emits
// from `engine.deactivate` (`kind === 'deactivated'` → `noHeadMessage(scope)`).
func (server *testServer) deactivate(scope string) {
	batch := &SnapshotBatch{Scope: scope, NoHead: true}

	server.mu.Lock()
	delete(server.heads, scope)
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

func TestSubscribeForwardsNoHeadDeactivations(t *testing.T) {
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

	time.Sleep(300 * time.Millisecond)
	service.activate("agentic", 1, "sha256:aaa", map[string]any{"agentic.lanes.vinci": map[string]any{"enabled": true}})

	select {
	case batch := <-received:
		if batch.Status != cnos.VarPullOK {
			t.Fatalf("first event: %#v", batch)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for the activation")
	}

	service.deactivate("agentic")

	select {
	case batch := <-received:
		if batch.Status != cnos.VarPullNoHead {
			t.Fatalf("expected a forwarded no_head deactivation, got %#v", batch)
		}
		if batch.Scope != "agentic" {
			t.Fatalf("a no_head event must carry its scope, got %q", batch.Scope)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the no_head deactivation was dropped by the provider")
	}
}

// TestRpcDeactivationRestoresStaticTierEndToEnd drives the whole chain over a real gRPC
// connection: activate -> the SDK serves the runtime tier -> deactivate -> the SDK falls back to
// the statically projected value.*, with no restart and no poller anywhere in the picture.
func TestRpcDeactivationRestoresStaticTierEndToEnd(t *testing.T) {
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	service.activate("flags", 1, "sha256:r1", map[string]any{"flags.mode": "runtime-tier"})

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
		// pollInterval is declared deliberately: an rpc source must IGNORE it (capability rule) and
		// rely on its subscription, so the fallback below can only have come from the push.
		VarSources: map[string]cnos.VarSourceDef{"svc": {Transport: "rpc", URL: server.target, PollInterval: "20ms"}},
		Vars:       map[string]cnos.VarGroupDef{"flags": {Source: "svc", Mode: "prefetch"}},
		Schema:     map[string]cnos.VarKeyRule{"var.flags.mode": {Type: "string"}},
	}

	payload, err := json.Marshal(projection)
	if err != nil {
		t.Fatalf("marshal projection: %v", err)
	}

	runtime, err := cnos.LoadProjection(payload, cnos.Options{
		SecretHome:         t.TempDir(),
		Environment:        map[string]string{},
		VarSourceProviders: []cnos.VarSourceProviderFactory{Factory()},
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
	service.deactivate("flags")

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if value, ok, _ := runtime.Var("flags.mode"); ok && value == "static-tier" {
			snapshot, _ := runtime.VarSnapshot("flags.mode")
			if snapshot.Source != cnos.VarSourceStatic {
				t.Fatalf("snapshot source after deactivation: %#v", snapshot)
			}
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("an rpc deactivation never restored the static tier (the no_head push was dropped)")
}
