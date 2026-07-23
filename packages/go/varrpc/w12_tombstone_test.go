package varrpc

import (
	"context"
	"encoding/json"
	"net"
	"reflect"
	"testing"
	"time"

	cnos "github.com/kitsyai/cnos/packages/go"
)

// W12 — HIERARCHICAL TOMBSTONE SEMANTICS, Go half.
//
// The Go SDK is a CONSUMER; the control-plane engine (subtree tombstoning, mutation-lock
// serialization) is TypeScript-only. These tests exercise the Go client + runtime against the Go
// test authority (which mirrors the TypeScript rpc server's W12 initial-sync + cascade wire), and
// assert that every canonical history converges to the same observable state — with NO transient
// fallback when a reconstruction contains an active child.

var (
	w12DocK      = map[string]any{"enabled": true, "model_target_ref": "k"}
	w12StaticK   = map[string]any{"enabled": false, "model_target_ref": "static"}
	w12DocS      = map[string]any{"enabled": true, "model_target_ref": "s"}
	w12StaticS   = map[string]any{"enabled": false, "model_target_ref": "static-s"}
	w12ChildVals = map[string]any{"agentic.lanes.vinci": w12DocK}
	w12SibVals   = map[string]any{"agentic.lanes.orion": w12DocS}
	w12GroupVals = map[string]any{"agentic.mode": "fast"}
)

// w12Runtime builds a full SDK runtime over an rpc source pointed at target, with static fallback
// tiers for the child, sibling, and group-mode keys.
func w12Runtime(t *testing.T, target string) *cnos.Runtime {
	t.Helper()
	projection := cnos.ServerProjection{
		Version:    1,
		Workspace:  "api",
		Profile:    "stage",
		ResolvedAt: "2026-07-20T00:00:00Z",
		ConfigHash: "hash",
		Values: map[string]any{
			"value.agentic.lanes.vinci": w12StaticK,
			"value.agentic.lanes.orion": w12StaticS,
			"value.agentic.mode":        "static-mode",
		},
		Derived:           map[string]cnos.DerivedFormula{},
		SecretRefs:        map[string]cnos.SecretReference{},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              cnos.ProjectionMeta{Workspace: "api", Profile: "stage", CnosVersion: "1.17.0"},
		VarSources:        map[string]cnos.VarSourceDef{"svc": {Transport: "rpc", URL: target}},
		Vars:              map[string]cnos.VarGroupDef{"agentic": {Source: "svc", Mode: "prefetch"}},
		Schema: map[string]cnos.VarKeyRule{
			"var.agentic.mode":        {Type: "string"},
			"var.agentic.lanes.vinci": {},
			"var.agentic.lanes.orion": {},
		},
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
	t.Cleanup(func() { _ = runtime.Close() })
	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("start vars: %v", err)
	}
	return runtime
}

func w12WaitChild(t *testing.T, runtime *cnos.Runtime, want map[string]any) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if value, ok, _ := runtime.Var("agentic.lanes.vinci"); ok && reflect.DeepEqual(value, want) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	value, _, _ := runtime.Var("agentic.lanes.vinci")
	t.Fatalf("child never converged to %#v (last %#v)", want, value)
}

// --- canonical histories, reconstructed by a fresh subscription ---

func TestW12FreshSubscribeChildBeforeParentDeactivationCleared(t *testing.T) {
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	// activate(g.key); deactivate(g) ⇒ both inactive.
	service.activate("agentic.lanes.vinci", 1, "sha256:k1", w12ChildVals)
	service.deactivate("agentic")

	runtime := w12Runtime(t, server.target)
	w12WaitChild(t, runtime, w12StaticK)
	if snap, _ := runtime.VarSnapshot("agentic.lanes.vinci"); snap.Source != cnos.VarSourceStatic {
		t.Fatalf("child source: %#v", snap)
	}
}

func TestW12FreshSubscribeChildAfterParentDeactivationSurvives(t *testing.T) {
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	// deactivate(g); activate(g.key) ⇒ g.key ACTIVE (the tombstone is not a persistent mask).
	service.deactivate("agentic")
	service.activate("agentic.lanes.vinci", 1, "sha256:k1", w12ChildVals)

	runtime := w12Runtime(t, server.target)
	w12WaitChild(t, runtime, w12DocK)
	if snap, _ := runtime.VarSnapshot("agentic.lanes.vinci"); snap.Source != cnos.VarSourceRuntime {
		t.Fatalf("child source: %#v", snap)
	}
}

func TestW12FreshSubscribeParentReactivationDoesNotResurrectChild(t *testing.T) {
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	service.activate("agentic", 1, "sha256:g1", w12GroupVals)
	service.activate("agentic.lanes.vinci", 1, "sha256:k1", w12ChildVals)
	service.deactivate("agentic") // clears g and g.key
	service.activate("agentic", 2, "sha256:g2", w12GroupVals)

	runtime := w12Runtime(t, server.target)

	// Parent key served from runtime again…
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if value, ok, _ := runtime.Var("agentic.mode"); ok && value == "fast" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if value, _, _ := runtime.Var("agentic.mode"); value != "fast" {
		t.Fatalf("parent key never reactivated, got %#v", value)
	}
	// …but the tombstoned child stays on the static tier.
	w12WaitChild(t, runtime, w12StaticK)
}

func TestW12KeyTombstoneLeavesParentAndSiblingUnchanged(t *testing.T) {
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	service.activate("agentic", 1, "sha256:g1", w12GroupVals)
	service.activate("agentic.lanes.vinci", 1, "sha256:k1", w12ChildVals)
	service.activate("agentic.lanes.orion", 1, "sha256:s1", w12SibVals)
	service.deactivate("agentic.lanes.vinci") // affects only this key

	runtime := w12Runtime(t, server.target)

	// Wait for the sibling's head to be reconstructed, THEN assert the parent and sibling survived
	// the key-scoped tombstone while the child fell back to static.
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if value, ok, _ := runtime.Var("agentic.lanes.orion"); ok && reflect.DeepEqual(value, w12DocS) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if value, ok, _ := runtime.Var("agentic.lanes.orion"); !ok || !reflect.DeepEqual(value, w12DocS) {
		t.Fatalf("sibling changed: ok=%v value=%#v", ok, value)
	}
	if value, ok, _ := runtime.Var("agentic.mode"); !ok || value != "fast" {
		t.Fatalf("parent key changed: ok=%v value=%#v", ok, value)
	}
	w12WaitChild(t, runtime, w12StaticK)
}

// --- never-authored parent vs explicit tombstone (initial sync) ---

func TestW12NeverAuthoredParentReconstructsActiveChild(t *testing.T) {
	service := newTestServer()
	server := serveOn(t, service, nil)
	defer server.stop()

	// g was NEVER deactivated; only the child scope is authored. The initial sync must not emit a
	// synthetic parent no_head that would cascade-clear the child.
	service.activate("agentic.lanes.vinci", 1, "sha256:k1", w12ChildVals)

	runtime := w12Runtime(t, server.target)
	w12WaitChild(t, runtime, w12DocK)
}

// --- reconnect: no transient fallback watcher event (the crux) ---

func TestW12ReconnectNeverExposesFallbackForActiveChildUnderTombstone(t *testing.T) {
	service := newTestServer()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	target := listener.Addr().String()
	server := serveOn(t, service, listener)

	// History-2 state: g deactivated, then g.key activated; the client holds g.key active.
	service.deactivate("agentic")
	service.activate("agentic.lanes.vinci", 1, "sha256:k1", w12ChildVals)

	runtime := w12Runtime(t, target)
	w12WaitChild(t, runtime, w12DocK)

	// Watch the child, then force a reconnect. The reconstruction sends an EXACT no_head for the
	// tombstoned parent (cascade=false) followed by the still-active child head; the exact no_head
	// must NOT clear the child, so the watcher must NEVER see a fallback transition.
	fires := make(chan cnos.Snapshot, 16)
	unwatch := runtime.Watch("var.agentic.lanes.vinci", func(next, _ cnos.Snapshot) { fires <- next })
	defer unwatch()

	time.Sleep(300 * time.Millisecond)
	server.stop()
	time.Sleep(100 * time.Millisecond)
	restarted := restartOnSamePort(t, service, target)
	defer restarted.stop()

	time.Sleep(2 * time.Second)

	select {
	case fire := <-fires:
		t.Fatalf("a reconnect fired a transient watcher event for the surviving child: %#v", fire)
	default:
	}

	if value, ok, _ := runtime.Var("agentic.lanes.vinci"); !ok || !reflect.DeepEqual(value, w12DocK) {
		t.Fatalf("child not still active after reconnect: ok=%v value=%#v", ok, value)
	}
}

// --- server-level subtree atomicity (the Go authority mirrors the TS engine) ---

func TestW12ServerDeactivateClearsActiveDescendants(t *testing.T) {
	service := newTestServer()
	service.activate("agentic", 1, "sha256:g1", w12GroupVals)
	service.activate("agentic.lanes.vinci", 1, "sha256:k1", w12ChildVals)
	service.activate("agentic.lanes.orion", 1, "sha256:s1", w12SibVals)

	service.deactivate("agentic")

	service.mu.Lock()
	defer service.mu.Unlock()
	for _, scope := range []string{"agentic", "agentic.lanes.vinci", "agentic.lanes.orion"} {
		if service.heads[scope] != nil {
			t.Fatalf("scope %q was not cleared by the subtree deactivation", scope)
		}
		if service.generations[scope] == 0 {
			t.Fatalf("scope %q generation was not bumped by the deactivation", scope)
		}
	}
}
