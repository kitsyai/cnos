package cnos

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// Review round 3 regressions (Go side). Every test here has a Node twin — cross-SDK semantic
// parity is the through-line of all three review rounds, and a behavior tested in only one SDK
// is exactly how these defects survived.
//
//	BLOCKER 2 — close() racing an in-flight startup leaked providers/pollers/subscriptions.
//	BLOCKER 3 — a missing transport module must not waive REQUIRED enforcement (Node half).
//	BLOCKER 4 — a group commit MERGED instead of replacing the scope, so a key dropped by a new
//	            revision (a removed allowlist entry, a revoked flag) kept being served.
//	WARNING 5 — no ordering between a no-head and an in-flight pull.
//	WARNING 6 — watcher dispatch was not sequenced against concurrent/reentrant mutation.
//	WARNING 8 — an empty no-head skipped the refresh/error metadata update.

// --- BLOCKER 4: a revision REPLACES its scope ---------------------------------------------

func TestVarRevisionReplacesScopeAndDropsVanishedKeys(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	// `flags.b` has a static twin so its disappearance is observable as a real fallback.
	projection.Values["value.flags.b"] = "static-b"
	projection.Vars = map[string]VarGroupDef{"flags": {Mode: "ondemand"}}
	projection.Schema = map[string]VarKeyRule{
		"var.flags.a": {Type: "string"},
		"var.flags.b": {Type: "string"},
	}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	var mu sync.Mutex
	seen := []string{}
	runtime.Watch("var.flags.b", func(next, _ Snapshot) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, string(next.Source)+"="+toString(next.Value))
	})

	_ = runtime.vars.ingest(varBatch{
		scope: "flags", group: "flags", generation: 1, revision: "sha256:r1",
		values: map[string]any{"flags.a": "a1", "flags.b": "b1"},
	}, "test")

	if value, _, _ := runtime.Var("flags.b"); value != "b1" {
		t.Fatalf("expected the runtime tier, got %v", value)
	}

	// Revision 2 OMITS flags.b. A merge keeps serving the withdrawn value forever, which is
	// exactly what a removed allowlist entry or a revoked policy flag looks like.
	_ = runtime.vars.ingest(varBatch{
		scope: "flags", group: "flags", generation: 2, revision: "sha256:r2",
		values: map[string]any{"flags.a": "a2"},
	}, "test")

	if value, _, _ := runtime.Var("flags.a"); value != "a2" {
		t.Fatalf("flags.a should be replaced, got %v", value)
	}
	if value, ok, _ := runtime.Var("flags.b"); !ok || value != "static-b" {
		t.Fatalf("a key dropped by the replacement revision must fall back to static, got %v (ok=%v)", value, ok)
	}
	snapshot, _ := runtime.VarSnapshot("flags.b")
	if snapshot.Source != VarSourceStatic {
		t.Fatalf("snapshot source after the drop: %#v", snapshot)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 || seen[0] != "runtime=b1" || seen[1] != "static=static-b" {
		t.Fatalf("watchers must see the drop as a fallback transition, got %v", seen)
	}
}

func TestVarNarrowerScopeSurvivesABroaderCommit(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Vars = map[string]VarGroupDef{"g": {Mode: "ondemand"}}
	projection.Schema = map[string]VarKeyRule{"var.g.a.x": {Type: "string"}, "var.g.b": {Type: "string"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	_ = runtime.vars.ingest(varBatch{
		scope: "g", group: "g", generation: 1, revision: "sha256:r1",
		values: map[string]any{"g.a.x": "broad", "g.b": "b1"},
	}, "test")
	_ = runtime.vars.ingest(varBatch{
		scope: "g.a", group: "g", generation: 1, revision: "sha256:k1",
		values: map[string]any{"g.a.x": "narrow"},
	}, "test")

	// The longest committed scope that prefixes the key wins.
	if value, _, _ := runtime.Var("g.a.x"); value != "narrow" {
		t.Fatalf("the narrower scope must shadow the broader one, got %v", value)
	}

	// Replacing the BROAD scope leaves the independently authored narrow scope untouched.
	_ = runtime.vars.ingest(varBatch{
		scope: "g", group: "g", generation: 2, revision: "sha256:r2",
		values: map[string]any{"g.b": "b2"},
	}, "test")

	if value, _, _ := runtime.Var("g.a.x"); value != "narrow" {
		t.Fatalf("a broad commit must not wipe a narrower scope, got %v", value)
	}
	if value, _, _ := runtime.Var("g.b"); value != "b2" {
		t.Fatalf("g.b should be replaced, got %v", value)
	}
}

// --- WARNING 5: mixed pull/push ordering ---------------------------------------------------

// gatedProvider holds Pull open until released, so a push can be interleaved with a pull that
// is still in flight.
type gatedProvider struct {
	release chan struct{}
	mu      sync.Mutex
	onBatch func(VarBatchResult)
}

func (provider *gatedProvider) Pull(ctx context.Context, scope VarScope, _ string) (VarBatchResult, error) {
	select {
	case <-provider.release:
	case <-ctx.Done():
		return VarBatchResult{}, ctx.Err()
	}
	// Deliberately STALE: the head the authority served before the deactivation.
	return VarBatchResult{
		Status: VarPullOK, Scope: scope.Scope(), Generation: 1, Revision: "sha256:stale",
		EffectiveAt: "2026-07-20T00:00:00Z",
		Values:      map[string]any{"flags.mode": "stale-head"},
	}, nil
}

func (provider *gatedProvider) Subscribe(_ context.Context, _ []VarScope, onBatch func(VarBatchResult)) (func(), error) {
	provider.mu.Lock()
	provider.onBatch = onBatch
	provider.mu.Unlock()
	return func() {}, nil
}

func (provider *gatedProvider) Close() error { return nil }

func TestVarPullSupersededByAPushIsDropped(t *testing.T) {
	t.Parallel()
	provider := &gatedProvider{release: make(chan struct{})}

	projection := baseVarProjection()
	projection.Values["value.flags.mode"] = "static-tier"
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "gated", URL: "unused"}}
	projection.Vars = map[string]VarGroupDef{"flags": {Source: "svc", Mode: "prefetch"}}
	projection.Schema = map[string]VarKeyRule{"var.flags.mode": {Type: "string"}}

	runtime := mustLoadProjectionRuntime(t, projection, Options{
		SecretHome:  t.TempDir(),
		Environment: map[string]string{},
		VarSourceProviders: []VarSourceProviderFactory{{
			Transport: "gated",
			Create: func(VarSourceDef, VarProviderContext) (VarSourceProvider, error) { return provider, nil },
		}},
	})
	defer runtime.Close()

	done := make(chan error, 1)
	go func() { done <- runtime.StartVars(context.Background()) }()

	// While the prefetch pull hangs, the authority pushes a DEACTIVATION for the same scope.
	time.Sleep(50 * time.Millisecond)
	runtime.vars.applyNoHead("flags")

	close(provider.release)
	<-done

	if value, ok, _ := runtime.Var("flags.mode"); !ok || value != "static-tier" {
		t.Fatalf("a stale pull must not reintroduce the withdrawn head, got %v (ok=%v)", value, ok)
	}
}

// --- WARNING 6: watcher dispatch ordering --------------------------------------------------

func TestVarWatcherDispatchIsOrderedAgainstReentrantMutation(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Values["value.flags.mode"] = "static"
	projection.Vars = map[string]VarGroupDef{"flags": {Mode: "ondemand"}}
	projection.Schema = map[string]VarKeyRule{"var.flags.mode": {Type: "string"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	variables := runtime.vars
	_ = variables.ingest(varBatch{
		scope: "flags", group: "flags", generation: 1, revision: "sha256:r1",
		values: map[string]any{"flags.mode": "v1"},
	}, "test")

	var mu sync.Mutex
	first := []string{}
	second := []string{}
	reactivated := false

	runtime.Watch("var.flags.mode", func(next, _ Snapshot) {
		mu.Lock()
		first = append(first, toString(next.Value))
		trigger := next.Source == VarSourceStatic && !reactivated
		if trigger {
			reactivated = true
		}
		mu.Unlock()

		// Re-entrant commit from inside the callback. It must NOT become visible to the
		// watchers that have not yet received the event currently being delivered.
		if trigger {
			_ = variables.ingest(varBatch{
				scope: "flags", group: "flags", generation: 3, revision: "sha256:r3",
				values: map[string]any{"flags.mode": "v3"},
			}, "test")
		}
	})
	runtime.Watch("var.flags.mode", func(next, _ Snapshot) {
		mu.Lock()
		second = append(second, toString(next.Value))
		mu.Unlock()
	})

	variables.applyNoHead("flags")

	mu.Lock()
	defer mu.Unlock()
	want := []string{"static", "v3"}
	if !equalStrings(first, want) || !equalStrings(second, want) {
		t.Fatalf("both watchers must observe the same order %v, got first=%v second=%v", want, first, second)
	}
}

// --- WARNING 8: an empty no-head still records refresh metadata ---------------------------

func TestVarEmptyNoHeadClearsAStaleTransportError(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Values["value.flags.mode"] = "static-tier"
	projection.Vars = map[string]VarGroupDef{"flags": {Mode: "ondemand"}}
	projection.Schema = map[string]VarKeyRule{"var.flags.mode": {Type: "string"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	// A transport failure records lastError...
	runtime.vars.recordError("flags", "connection refused")
	if runtime.VarStatus()["flags.mode"].LastError == "" {
		t.Fatal("precondition: the transport error should be recorded")
	}

	// ...and a DEFINITIVE no-head on an empty store is a recovery, not a failure. Returning
	// early on `len(removed) == 0` left Go reporting the stale error forever while Node
	// reported recovery.
	runtime.vars.applyNoHead("flags")

	status := runtime.VarStatus()["flags.mode"]
	if status.LastError != "" {
		t.Fatalf("a valid no-head must clear the stale error, got %q", status.LastError)
	}
	if status.LastRefreshAt == "" {
		t.Fatal("a valid no-head must record a refresh even when it removed nothing")
	}
}

// --- BLOCKER 3: a missing transport module never waives REQUIRED enforcement --------------

func TestStartVarsFailsWhenTheTransportModuleIsMissingAndNoFallbackResolves(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "nonexistent", URL: "unused"}}
	projection.Vars = map[string]VarGroupDef{"flags": {Source: "svc", Mode: "prefetch"}}
	projection.Schema = map[string]VarKeyRule{"var.flags.mode": {Type: "string", Required: true}}

	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	err := runtime.StartVars(context.Background())
	if !errors.Is(err, ErrVarRequired) {
		t.Fatalf("a missing transport module with no fallback must fail startup, got %v", err)
	}
}

func TestStartVarsSucceedsWhenTheTransportModuleIsMissingButAFallbackResolves(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Values["value.flags.mode"] = "static-tier"
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "nonexistent", URL: "unused"}}
	projection.Vars = map[string]VarGroupDef{"flags": {Source: "svc", Mode: "prefetch"}}
	projection.Schema = map[string]VarKeyRule{"var.flags.mode": {Type: "string", Required: true}}

	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("a missing transport module is a warned deployment gap when a tier resolves: %v", err)
	}
	if value, ok, _ := runtime.Var("flags.mode"); !ok || value != "static-tier" {
		t.Fatalf("expected the static tier, got %v (ok=%v)", value, ok)
	}
}

// --- BLOCKER 2: close() vs an in-flight startup -------------------------------------------

// lifecycleProvider records construction/close and subscription start/stop so a test can prove
// nothing a racing startup created survives close().
type lifecycleProvider struct {
	release chan struct{}

	mu          sync.Mutex
	closes      int
	subscribes  int
	stops       int
	subscribeAt func()
}

func (provider *lifecycleProvider) Pull(ctx context.Context, scope VarScope, _ string) (VarBatchResult, error) {
	select {
	case <-provider.release:
	case <-ctx.Done():
		return VarBatchResult{}, ctx.Err()
	}
	return VarBatchResult{
		Status: VarPullOK, Scope: scope.Scope(), Generation: 1, Revision: "sha256:r1",
		EffectiveAt: "2026-07-20T00:00:00Z",
		Values:      map[string]any{"flags.mode": "runtime-tier"},
	}, nil
}

func (provider *lifecycleProvider) Subscribe(_ context.Context, _ []VarScope, _ func(VarBatchResult)) (func(), error) {
	provider.mu.Lock()
	provider.subscribes++
	provider.mu.Unlock()
	return func() {
		provider.mu.Lock()
		provider.stops++
		provider.mu.Unlock()
	}, nil
}

func (provider *lifecycleProvider) Close() error {
	provider.mu.Lock()
	provider.closes++
	provider.mu.Unlock()
	return nil
}

func (provider *lifecycleProvider) counts() (closes, subscribes, stops int) {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	return provider.closes, provider.subscribes, provider.stops
}

func TestCloseReleasesEverythingAnInFlightStartupCreates(t *testing.T) {
	t.Parallel()
	provider := &lifecycleProvider{release: make(chan struct{})}

	projection := baseVarProjection()
	projection.Values["value.flags.mode"] = "static-tier"
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "lifecycle", URL: "unused"}}
	projection.Vars = map[string]VarGroupDef{"flags": {Source: "svc", Mode: "prefetch"}}
	projection.Schema = map[string]VarKeyRule{"var.flags.mode": {Type: "string"}}

	runtime := mustLoadProjectionRuntime(t, projection, Options{
		SecretHome:  t.TempDir(),
		Environment: map[string]string{},
		VarSourceProviders: []VarSourceProviderFactory{{
			Transport: "lifecycle",
			Create: func(VarSourceDef, VarProviderContext) (VarSourceProvider, error) { return provider, nil },
		}},
	})

	started := make(chan error, 1)
	go func() { started <- runtime.StartVars(context.Background()) }()

	// close() while the prefetch pull is still blocked.
	time.Sleep(50 * time.Millisecond)
	closed := make(chan error, 1)
	go func() { closed <- runtime.Close() }()

	time.Sleep(50 * time.Millisecond)
	close(provider.release)

	select {
	case err := <-closed:
		if err != nil {
			t.Fatalf("close: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("close() never returned: it is not coordinated with the in-flight startup")
	}

	select {
	case err := <-started:
		// A startup that observed a closed runtime must FAIL, never report success.
		if err == nil {
			t.Fatal("StartVars must not report success for a runtime closed while it ran")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("StartVars never returned")
	}

	closes, subscribes, stops := provider.counts()
	if closes != 1 {
		t.Fatalf("the provider must be closed exactly once, got %d", closes)
	}
	if subscribes != stops {
		t.Fatalf("every subscription the attempt created must be stopped: %d started, %d stopped", subscribes, stops)
	}

	// And a start AFTER close is a hard failure, not a silent success.
	if err := runtime.StartVars(context.Background()); !errors.Is(err, ErrVarClosed) {
		t.Fatalf("StartVars on a closed runtime must return ErrVarClosed, got %v", err)
	}
}

// --- helpers ------------------------------------------------------------------------------

func toString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	if value == nil {
		return "<nil>"
	}
	return "?"
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
