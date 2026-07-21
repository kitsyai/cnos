package cnos

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// Review round 2 regressions. Every test here fails against the pre-fix SDK:
//
//	BLOCKER 1 — a no-head (pull OR push) left the previously applied snapshot in place, so a
//	            deactivated revision kept being served forever.
//	BLOCKER 3 — a concurrent StartVars saw the `started` flag and returned nil before prefetch
//	            had finished, telling caller #2 the runtime was ready.
//	WARNING 4 — StartVars(ctx) ignored its ctx and ran prefetch on the runtime-lifetime ctx.
//	WARNING 5 — pollers were keyed off `pollInterval` alone, so an rpc source both subscribed
//	            AND polled.

// --- a fake subscribing provider (the capability that decides polling) ---------------------

type fakeSubscribingProvider struct {
	mu        sync.Mutex
	pulls     int
	head      *VarBatchResult
	onBatch   func(VarBatchResult)
	subscribe int
}

func (provider *fakeSubscribingProvider) Pull(_ context.Context, scope VarScope, knownRevision string) (VarBatchResult, error) {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	provider.pulls++
	if provider.head == nil {
		return VarBatchResult{Status: VarPullNoHead, Scope: scope.Scope()}, nil
	}
	return *provider.head, nil
}

func (provider *fakeSubscribingProvider) Subscribe(_ context.Context, _ []VarScope, onBatch func(VarBatchResult)) (func(), error) {
	provider.mu.Lock()
	provider.subscribe++
	provider.onBatch = onBatch
	provider.mu.Unlock()
	return func() {}, nil
}

func (provider *fakeSubscribingProvider) Close() error { return nil }

func (provider *fakeSubscribingProvider) push(batch VarBatchResult) {
	provider.mu.Lock()
	handler := provider.onBatch
	provider.mu.Unlock()
	if handler != nil {
		handler(batch)
	}
}

func (provider *fakeSubscribingProvider) pullCount() int {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	return provider.pulls
}

func subscribingFactory(provider *fakeSubscribingProvider) VarSourceProviderFactory {
	return VarSourceProviderFactory{
		Transport: "rpc",
		Create: func(VarSourceDef, VarProviderContext) (VarSourceProvider, error) {
			return provider, nil
		},
	}
}

// --- BLOCKER 1: deactivation clears the applied snapshot ----------------------------------

func TestVarDeactivationOverHttpRestoresStaticTier(t *testing.T) {
	t.Parallel()
	// Acceptance #15, end to end and both ways: static -> runtime -> static, driven only by the
	// authority's activation state, with no redeploy and no restart.
	server := newFakeVarServer()
	httpServer := httptest.NewServer(server.handler())
	defer httpServer.Close()

	projection := baseVarProjection()
	projection.Values = map[string]any{"value.flags.mode": "static-tier"}
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: httpServer.URL}}
	projection.Vars = map[string]VarGroupDef{"flags": {Source: "svc", Mode: "prefetch"}}
	projection.Schema = map[string]VarKeyRule{"var.flags.mode": {}}

	server.activate(map[string]any{"flags.mode": "runtime-tier"}, "sha256:r1")

	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	observed := make(chan Snapshot, 8)
	runtime.Watch("var.flags.mode", func(next, _ Snapshot) { observed <- next })

	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	if value, _, _ := runtime.Var("flags.mode"); value != "runtime-tier" {
		t.Fatalf("runtime tier: got %v, want runtime-tier", value)
	}

	// Deactivate at the authority; the next pull answers no-head.
	server.deactivate()
	if err := runtime.RefreshVars(context.Background()); err != nil {
		t.Fatalf("refresh after deactivate: %v", err)
	}

	if value, ok, _ := runtime.Var("flags.mode"); !ok || value != "static-tier" {
		t.Fatalf("after deactivate: got %v (ok=%v), want static-tier", value, ok)
	}

	snapshot, ok := runtime.VarSnapshot("flags.mode")
	if !ok || snapshot.Source != VarSourceStatic {
		t.Fatalf("snapshot after deactivate: %#v", snapshot)
	}
	if snapshot.Revision != "" || snapshot.Generation != 0 {
		t.Fatalf("a removed head must not keep serving its revision/generation: %#v", snapshot)
	}

	// The watcher must have been told: the EFFECTIVE value changed.
	deadline := time.After(2 * time.Second)
	sawStatic := false
	for !sawStatic {
		select {
		case snap := <-observed:
			if snap.Source == VarSourceStatic && snap.Value == "static-tier" {
				sawStatic = true
			}
		case <-deadline:
			t.Fatal("no watcher fire for the deactivation")
		}
	}

	status := runtime.VarStatus()["flags.mode"]
	if status.Source != VarSourceStatic {
		t.Fatalf("status source after deactivate: got %q, want static", status.Source)
	}
	if status.Revision != "" || status.AppliedGeneration != 0 || status.DesiredGeneration != nil {
		t.Fatalf("status must not report the removed head as applied: %#v", status)
	}
}

func TestVarDeactivationIsIdempotentAndTransportErrorsRetainLastKnownGood(t *testing.T) {
	t.Parallel()
	server := newFakeVarServer()
	httpServer := httptest.NewServer(server.handler())
	defer httpServer.Close()

	projection := baseVarProjection()
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: httpServer.URL}}
	projection.Vars = map[string]VarGroupDef{"flags": {Source: "svc", Mode: "prefetch"}}
	projection.Schema = map[string]VarKeyRule{"var.flags.mode": {}}

	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	fires := 0
	var mu sync.Mutex
	runtime.Watch("var.flags.mode", func(Snapshot, Snapshot) {
		mu.Lock()
		fires++
		mu.Unlock()
	})

	// A no-head with nothing applied is a silent no-op: no watcher fire.
	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	mu.Lock()
	if fires != 0 {
		t.Fatalf("no-head on an empty store must fire no watcher, got %d", fires)
	}
	mu.Unlock()

	server.activate(map[string]any{"flags.mode": "runtime-tier"}, "sha256:r1")
	if err := runtime.RefreshVars(context.Background()); err != nil {
		t.Fatalf("refresh: %v", err)
	}

	// A TRANSPORT FAILURE is not a no-head: last-known-good is retained.
	server.setFailure(http.StatusInternalServerError, "boom")
	_ = runtime.RefreshVars(context.Background())
	if value, _, _ := runtime.Var("flags.mode"); value != "runtime-tier" {
		t.Fatalf("a transport error must retain last-known-good, got %v", value)
	}

	// A definitive no-head clears it.
	server.setFailure(0, "")
	server.deactivate()
	if err := runtime.RefreshVars(context.Background()); err != nil {
		t.Fatalf("refresh after deactivate: %v", err)
	}
	if _, ok, _ := runtime.Var("flags.mode"); ok {
		t.Fatal("after deactivation the key must resolve from no tier (no static, no default)")
	}

	mu.Lock()
	after := fires
	mu.Unlock()

	// Repeating the no-head changes nothing and wakes nobody.
	if err := runtime.RefreshVars(context.Background()); err != nil {
		t.Fatalf("second refresh: %v", err)
	}
	mu.Lock()
	if fires != after {
		t.Fatalf("a repeated no-head must be a silent no-op, fires %d -> %d", after, fires)
	}
	mu.Unlock()
}

func TestVarPushedNoHeadDeactivatesWithoutAPoller(t *testing.T) {
	t.Parallel()
	// The rpc shape of BLOCKER 1: a subscribe-capable source has no poller, so a dropped no_head
	// push meant the consumer served a deactivated revision forever with no pull to converge on.
	provider := &fakeSubscribingProvider{}
	projection := baseVarProjection()
	projection.Values = map[string]any{"value.flags.mode": "static-tier"}
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "rpc", URL: "127.0.0.1:1", PollInterval: "20ms"}}
	projection.Vars = map[string]VarGroupDef{"flags": {Source: "svc", Mode: "prefetch"}}
	projection.Schema = map[string]VarKeyRule{"var.flags.mode": {}}

	provider.head = &VarBatchResult{
		Status:      VarPullOK,
		Scope:       "flags",
		Generation:  1,
		Revision:    "sha256:r1",
		EffectiveAt: "2026-07-20T00:00:00Z",
		Values:      map[string]any{"flags.mode": "runtime-tier"},
	}

	runtime := mustLoadProjectionRuntime(t, projection, Options{
		SecretHome:         t.TempDir(),
		Environment:        map[string]string{},
		VarSourceProviders: []VarSourceProviderFactory{subscribingFactory(provider)},
	})
	defer runtime.Close()

	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	if value, _, _ := runtime.Var("flags.mode"); value != "runtime-tier" {
		t.Fatalf("runtime tier: got %v", value)
	}

	// WARNING 5: a subscribe-capable source is never polled, even with a pollInterval declared.
	pullsAfterStart := provider.pullCount()
	time.Sleep(150 * time.Millisecond)
	if provider.pullCount() != pullsAfterStart {
		t.Fatalf("a subscribe-capable source must not be polled: pulls %d -> %d", pullsAfterStart, provider.pullCount())
	}

	// The deactivation arrives purely as a push.
	provider.push(VarBatchResult{Status: VarPullNoHead, Scope: "flags"})

	if value, ok, _ := runtime.Var("flags.mode"); !ok || value != "static-tier" {
		t.Fatalf("a pushed no_head must restore the static tier: got %v (ok=%v)", value, ok)
	}
}

// --- BLOCKER 3 / WARNING 4: startup attempt sharing and ctx --------------------------------

// blockingProvider gates Pull on a release channel so a test can hold startup open.
type blockingProvider struct {
	release chan struct{}
	fail    bool
	pulls   int64
	mu      sync.Mutex
}

func (provider *blockingProvider) Pull(ctx context.Context, scope VarScope, _ string) (VarBatchResult, error) {
	provider.mu.Lock()
	provider.pulls++
	provider.mu.Unlock()

	select {
	case <-provider.release:
	case <-ctx.Done():
		return VarBatchResult{}, ctx.Err()
	}

	if provider.fail {
		return VarBatchResult{}, errors.New("provider is down")
	}
	return VarBatchResult{
		Status:      VarPullOK,
		Scope:       scope.Scope(),
		Generation:  1,
		Revision:    "sha256:r1",
		EffectiveAt: "2026-07-20T00:00:00Z",
		Values:      map[string]any{"flags.mode": "runtime-tier"},
	}, nil
}

func (provider *blockingProvider) Close() error { return nil }

func blockingRuntime(t *testing.T, provider *blockingProvider, required bool) *Runtime {
	t.Helper()
	projection := baseVarProjection()
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "blocking", URL: "unused"}}
	projection.Vars = map[string]VarGroupDef{"flags": {Source: "svc", Mode: "prefetch"}}
	projection.Schema = map[string]VarKeyRule{"var.flags.mode": {Required: required}}

	return mustLoadProjectionRuntime(t, projection, Options{
		SecretHome:  t.TempDir(),
		Environment: map[string]string{},
		VarSourceProviders: []VarSourceProviderFactory{{
			Transport: "blocking",
			Create: func(VarSourceDef, VarProviderContext) (VarSourceProvider, error) {
				return provider, nil
			},
		}},
	})
}

func TestStartVarsSharesTheInFlightAttempt(t *testing.T) {
	t.Parallel()
	// Two concurrent callers must observe the SAME outcome, and neither may return before the
	// attempt completes. Pre-fix, caller #2 saw `started = true` and returned nil immediately —
	// reporting a ready runtime while prefetch was still in flight (and might yet fail).
	provider := &blockingProvider{release: make(chan struct{}), fail: true}
	runtime := blockingRuntime(t, provider, true)
	defer runtime.Close()

	type outcome struct {
		err      error
		returned time.Time
	}
	results := make(chan outcome, 2)
	var ready sync.WaitGroup
	ready.Add(2)

	for i := 0; i < 2; i++ {
		go func() {
			ready.Done()
			err := runtime.StartVars(context.Background())
			results <- outcome{err: err, returned: time.Now()}
		}()
	}

	ready.Wait()
	time.Sleep(150 * time.Millisecond)

	select {
	case result := <-results:
		t.Fatalf("StartVars returned (%v) before the attempt completed", result.err)
	default:
	}

	released := time.Now()
	close(provider.release)

	first := <-results
	second := <-results

	if first.err == nil || second.err == nil {
		t.Fatalf("both callers must observe the failure: %v / %v", first.err, second.err)
	}
	if first.err.Error() != second.err.Error() {
		t.Fatalf("callers observed different outcomes: %v vs %v", first.err, second.err)
	}
	if first.returned.Before(released) || second.returned.Before(released) {
		t.Fatal("a caller returned before the shared attempt completed")
	}

	// The failed attempt was cleared, so a retry is possible — and it really re-runs prefetch.
	before := provider.pulls
	provider.fail = false
	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("retry after a failed start: %v", err)
	}
	if provider.pulls <= before {
		t.Fatal("the retry did not re-run prefetch (the failed attempt was still latched)")
	}

	// A successful attempt IS kept: repeat calls are cheap no-ops.
	after := provider.pulls
	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("repeat start after success: %v", err)
	}
	if provider.pulls != after {
		t.Fatal("a successful start must not be repeated")
	}
}

func TestStartVarsHonorsTheCallerContext(t *testing.T) {
	t.Parallel()
	// WARNING 4: the caller's ctx must bound startup. Pre-fix, prefetch ran on the runtime's own
	// lifetime ctx, so a caller deadline could not cancel it and http would block for its 30s
	// client timeout.
	provider := &blockingProvider{release: make(chan struct{})}
	runtime := blockingRuntime(t, provider, false)
	defer runtime.Close()
	defer close(provider.release)

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	started := time.Now()
	err := runtime.StartVars(ctx)
	elapsed := time.Since(started)

	if err == nil {
		t.Fatal("expected StartVars to fail once the caller ctx expired")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected a ctx error, got %v", err)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("StartVars ignored the caller ctx (took %s)", elapsed)
	}
}

// --- BLOCKER 2 mirror: required prefetch outcomes -----------------------------------------

func TestRequiredPrefetchFailsReadyOnAValidationRejectedRevision(t *testing.T) {
	t.Parallel()
	// The Node twin of this is `required prefetch + validation-rejected payload fails ready()`.
	server := newFakeVarServer()
	httpServer := httptest.NewServer(server.handler())
	defer httpServer.Close()
	server.activate(map[string]any{"flags.mode": 42}, "sha256:bad") // schema says string

	projection := baseVarProjection()
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: httpServer.URL}}
	projection.Vars = map[string]VarGroupDef{"flags": {Source: "svc", Mode: "prefetch"}}
	projection.Schema = map[string]VarKeyRule{"var.flags.mode": {Type: "string", Required: true}}

	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	if err := runtime.StartVars(context.Background()); !errors.Is(err, ErrVarRequired) {
		t.Fatalf("expected ErrVarRequired for a rejected required prefetch revision, got %v", err)
	}
}

func TestRequiredPrefetchWithAMissingProviderIsNonFatal(t *testing.T) {
	t.Parallel()
	// The carve-out both SDKs keep: a missing transport MODULE is a deployment gap, not a
	// startup failure, as long as a fallback tier can satisfy the required key.
	projection := baseVarProjection()
	projection.Values = map[string]any{"value.flags.mode": "static-tier"}
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "rpc", URL: "127.0.0.1:1"}}
	projection.Vars = map[string]VarGroupDef{"flags": {Source: "svc", Mode: "prefetch"}}
	projection.Schema = map[string]VarKeyRule{"var.flags.mode": {Type: "string", Required: true}}

	runtime := loadVarRuntime(t, projection, nil) // no rpc factory registered
	defer runtime.Close()

	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("a missing transport module with a static fallback must not fail start: %v", err)
	}
	if value, _, _ := runtime.Var("flags.mode"); value != "static-tier" {
		t.Fatalf("expected the static tier to serve, got %v", value)
	}
}

// --- WARNING 5: poller capability rule ----------------------------------------------------

func TestPollerRunsForPullOnlyProvidersOnly(t *testing.T) {
	t.Parallel()
	// A pull-only provider WITH a pollInterval polls; the capability, not the transport name,
	// is what decides. (The subscribe-capable half is asserted in
	// TestVarPushedNoHeadDeactivatesWithoutAPoller.)
	server := newFakeVarServer()
	httpServer := httptest.NewServer(server.handler())
	defer httpServer.Close()
	server.activate(map[string]any{"flags.mode": "one"}, "sha256:r1")

	projection := baseVarProjection()
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: httpServer.URL, PollInterval: "30ms"}}
	projection.Vars = map[string]VarGroupDef{"flags": {Source: "svc", Mode: "prefetch"}}
	projection.Schema = map[string]VarKeyRule{"var.flags.mode": {Type: "string"}}

	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}

	server.activate(map[string]any{"flags.mode": "two"}, "sha256:r2")

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if value, _, _ := runtime.Var("flags.mode"); value == "two" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the http poller never picked up the new head")
}
