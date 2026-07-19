package cnos

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	goruntime "runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// --- fake var server implementing the http wire contract ---

type fakeVarServer struct {
	mu          sync.Mutex
	generation  int64
	revision    string
	schemaId    string
	effectiveAt string
	values      map[string]any
	hasHead     bool
	failStatus  int    // when >0, respond with this status + {"code":...}
	failCode    string // wire error code for failStatus responses
	bearer      string // when set, require Authorization: Bearer <bearer>
	requests    int64  // total handled requests
}

func newFakeVarServer() *fakeVarServer {
	return &fakeVarServer{effectiveAt: "2026-07-20T00:00:00Z"}
}

func (server *fakeVarServer) activate(values map[string]any, revision string) {
	server.mu.Lock()
	defer server.mu.Unlock()
	server.generation++
	server.revision = revision
	server.values = values
	server.hasHead = true
}

func (server *fakeVarServer) setFailure(status int, code string) {
	server.mu.Lock()
	defer server.mu.Unlock()
	server.failStatus = status
	server.failCode = code
}

func (server *fakeVarServer) handler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		atomic.AddInt64(&server.requests, 1)
		server.mu.Lock()
		defer server.mu.Unlock()

		if server.bearer != "" {
			if request.Header.Get("Authorization") != "Bearer "+server.bearer {
				writer.WriteHeader(http.StatusUnauthorized)
				return
			}
		}
		if server.failStatus > 0 {
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(server.failStatus)
			_ = json.NewEncoder(writer).Encode(map[string]any{"code": server.failCode})
			return
		}
		if !server.hasHead {
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(writer).Encode(map[string]any{"code": "no-head"})
			return
		}
		if match := request.Header.Get("If-None-Match"); match != "" && match == server.revision {
			writer.WriteHeader(http.StatusNotModified)
			return
		}
		writer.Header().Set("ETag", server.revision)
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"generation":  server.generation,
			"revision":    server.revision,
			"schemaId":    server.schemaId,
			"effectiveAt": server.effectiveAt,
			"values":      server.values,
		})
	})
}

// --- helpers ---

func baseVarProjection() ServerProjection {
	return ServerProjection{
		Version:           1,
		Workspace:         "api",
		Profile:           "stage",
		ResolvedAt:        "2026-07-20T00:00:00Z",
		ConfigHash:        "hash",
		Values:            map[string]any{},
		Derived:           map[string]DerivedFormula{},
		SecretRefs:        map[string]SecretReference{},
		PublicKeys:        []string{},
		RuntimeNamespaces: []string{},
		Meta:              ProjectionMeta{Workspace: "api", Profile: "stage", CnosVersion: "1.17.0"},
	}
}

func loadVarRuntime(t *testing.T, projection ServerProjection, env map[string]string) *Runtime {
	t.Helper()
	if env == nil {
		env = map[string]string{}
	}
	return mustLoadProjectionRuntime(t, projection, Options{SecretHome: t.TempDir(), Environment: env})
}

// --- #1 overlay fallback with no head ---

func TestVarOverlayFallbackNoHead(t *testing.T) {
	t.Parallel()
	server := newFakeVarServer() // hasHead == false → 404 no-head
	httpServer := httptest.NewServer(server.handler())
	defer httpServer.Close()

	projection := baseVarProjection()
	projection.Values["user.IN.coupon_allowed"] = false // static value.* tier
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: httpServer.URL}}
	projection.Vars = map[string]VarGroupDef{"user": {Source: "svc", Mode: "prefetch"}}
	projection.Schema = map[string]VarKeyRule{"var.user.IN.coupon_allowed": {Type: "boolean", HasDefault: true, Default: true}}

	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()
	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("StartVars: %v", err)
	}

	value, ok, err := runtime.Var("user.IN.coupon_allowed")
	if err != nil || !ok {
		t.Fatalf("read: ok=%v err=%v", ok, err)
	}
	if value != false { // static tier wins over schema default
		t.Fatalf("expected static false, got %v", value)
	}
	snap, ok := runtime.VarSnapshot("user.IN.coupon_allowed")
	if !ok || snap.Source != VarSourceStatic {
		t.Fatalf("expected static source, got ok=%v source=%v", ok, snap.Source)
	}
}

func TestVarDefaultTierWhenNoStatic(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Schema = map[string]VarKeyRule{"var.user.flag": {Type: "boolean", HasDefault: true, Default: true}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	value, ok, err := runtime.Var("user.flag")
	if err != nil || !ok || value != true {
		t.Fatalf("expected default true, got ok=%v value=%v err=%v", ok, value, err)
	}
	snap, _ := runtime.VarSnapshot("user.flag")
	if snap.Source != VarSourceDefault {
		t.Fatalf("expected default source, got %v", snap.Source)
	}
}

// --- #2 activation visible without restart (poll + push) ---

func TestVarActivationVisibleViaPrefetchAndPoll(t *testing.T) {
	t.Parallel()
	server := newFakeVarServer()
	server.activate(map[string]any{"user.plan": "free"}, "sha256:rev1")
	httpServer := httptest.NewServer(server.handler())
	defer httpServer.Close()

	projection := baseVarProjection()
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: httpServer.URL, PollInterval: "20ms"}}
	projection.Vars = map[string]VarGroupDef{"user": {Source: "svc", Mode: "prefetch", TTL: "1h"}}

	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()
	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("StartVars: %v", err)
	}

	if value, _, _ := runtime.Var("user.plan"); value != "free" {
		t.Fatalf("prefetch: expected free, got %v", value)
	}

	// Activate a new revision; the poller should converge without restart.
	server.activate(map[string]any{"user.plan": "pro"}, "sha256:rev2")
	if !waitFor(t, 2*time.Second, func() bool {
		value, _, _ := runtime.Var("user.plan")
		return value == "pro"
	}) {
		t.Fatalf("poll did not converge to pro")
	}
}

func TestVarActivationViaReceiverPush(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.SecretRefs["push.token"] = SecretReference{Provider: "environment", Vault: "env", Ref: "push.token", EnvVar: "PUSH_TOKEN"}
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: "http://unused", Verify: "secret.push.token"}}
	projection.Vars = map[string]VarGroupDef{"user": {Source: "svc", Mode: "ondemand"}}

	runtime := loadVarRuntime(t, projection, map[string]string{"PUSH_TOKEN": "s3cr3t"})
	defer runtime.Close()

	handler := runtime.VarReceiver("svc")
	mux := http.NewServeMux()
	mux.Handle("/cnos/vars/", handler)
	pushServer := httptest.NewServer(mux)
	defer pushServer.Close()

	// unauthorized push is rejected
	body := `{"revision":"sha256:p1","generation":7,"values":{"user.plan":"enterprise"}}`
	respBad, _ := http.Post(pushServer.URL+"/cnos/vars/user", "application/json", strings.NewReader(body))
	if respBad.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for missing auth, got %d", respBad.StatusCode)
	}
	respBad.Body.Close()

	// authorized push commits and is visible
	request, _ := http.NewRequest(http.MethodPost, pushServer.URL+"/cnos/vars/user", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer s3cr3t")
	resp, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", resp.StatusCode)
	}
	if value, _, _ := runtime.Var("user.plan"); value != "enterprise" {
		t.Fatalf("push not visible, got %v", value)
	}
	snap, _ := runtime.VarSnapshot("user.plan")
	if snap.Generation != 7 || snap.Source != VarSourceRuntime {
		t.Fatalf("unexpected snapshot after push: %+v", snap)
	}
}

func TestVarReceiverHMACSignature(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.SecretRefs["ops.verify"] = SecretReference{Provider: "environment", Vault: "env", Ref: "ops.verify", EnvVar: "OPS_VERIFY"}
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: "http://unused", Verify: "secret.ops.verify"}}
	projection.Vars = map[string]VarGroupDef{"user": {Source: "svc", Mode: "ondemand"}}

	runtime := loadVarRuntime(t, projection, map[string]string{"OPS_VERIFY": "push-secret"})
	defer runtime.Close()

	mux := http.NewServeMux()
	mux.Handle("/cnos/vars/", runtime.VarReceiver("svc"))
	pushServer := httptest.NewServer(mux)
	defer pushServer.Close()

	body := `{"revision":"sha256:p1","generation":7,"values":{"user.plan":"enterprise"}}`
	mac := hmac.New(sha256.New, []byte("push-secret"))
	mac.Write([]byte(body))
	signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	// Correct `sha256=<hex>` signature is accepted (204).
	request, _ := http.NewRequest(http.MethodPost, pushServer.URL+"/cnos/vars/user", strings.NewReader(body))
	request.Header.Set("X-CNOS-Signature", signature)
	resp, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 for valid signature, got %d", resp.StatusCode)
	}

	// A signature WITHOUT the required `sha256=` prefix must fail (401).
	unprefixed, _ := http.NewRequest(http.MethodPost, pushServer.URL+"/cnos/vars/user", strings.NewReader(body))
	unprefixed.Header.Set("X-CNOS-Signature", hex.EncodeToString(mac.Sum(nil)))
	respBad, err := http.DefaultClient.Do(unprefixed)
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	respBad.Body.Close()
	if respBad.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unprefixed signature, got %d", respBad.StatusCode)
	}
}

// --- #3 atomic snapshots under concurrent readers (run with -race) ---

func TestVarAtomicSnapshotsUnderConcurrency(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Vars = map[string]VarGroupDef{"cfg": {Mode: "ondemand"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()
	variables := runtime.vars

	stop := make(chan struct{})
	var wg sync.WaitGroup
	// Readers assert they never observe a mixed batch: a and b always agree.
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				// A single atomic load of the store state must yield a
				// consistent view: a and b from the same committed batch agree.
				records := variables.store.state.Load().records
				aVal, aOK := records["var.cfg.a"]
				bVal, bOK := records["var.cfg.b"]
				if aOK && bOK {
					if aVal.base.Value != bVal.base.Value {
						t.Errorf("mixed batch observed: a=%v b=%v", aVal.base.Value, bVal.base.Value)
						return
					}
				}
			}
		}()
	}
	// Writer commits batches where a == b each generation.
	for gen := 1; gen <= 500; gen++ {
		_ = variables.ingest(varBatch{
			group:      "cfg",
			generation: int64(gen),
			revision:   "rev",
			values:     map[string]any{"cfg.a": gen, "cfg.b": gen},
		}, "test")
	}
	close(stop)
	wg.Wait()
}

// --- #4 invalid/unknown-field rejected, #5 LKG retained ---

func TestVarInvalidRevisionRejectedAndLKGRetained(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Documents = map[string]DocumentSchema{
		"lanes/v1": {
			Fields: map[string]DocumentField{
				"enabled": {Type: "boolean", Required: true},
				"target":  {Type: "string"},
			},
			AdditionalProperties: false,
		},
	}
	projection.Vars = map[string]VarGroupDef{"agentic": {Mode: "prefetch"}}
	projection.Schema = map[string]VarKeyRule{"var.agentic.lanes.vinci": {Document: "lanes/v1", Required: true}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()
	variables := runtime.vars

	good := map[string]any{"agentic.lanes.vinci": map[string]any{"enabled": true, "target": "m1"}}
	if err := variables.ingest(varBatch{group: "agentic", generation: 1, revision: "sha256:good", values: good}, "test"); err != nil {
		t.Fatalf("good ingest: %v", err)
	}

	// unknown field rejected (additionalProperties:false)
	bad := map[string]any{"agentic.lanes.vinci": map[string]any{"enabled": true, "budgets2": 5}}
	if err := variables.ingest(varBatch{group: "agentic", generation: 2, revision: "sha256:bad", values: bad}, "test"); err == nil {
		t.Fatalf("expected unknown-field rejection")
	}
	// missing required field rejected
	missing := map[string]any{"agentic.lanes.vinci": map[string]any{"target": "m2"}}
	if err := variables.ingest(varBatch{group: "agentic", generation: 3, revision: "sha256:missing", values: missing}, "test"); err == nil {
		t.Fatalf("expected missing-required rejection")
	}
	// wrong type rejected
	wrongType := map[string]any{"agentic.lanes.vinci": map[string]any{"enabled": "yes"}}
	if err := variables.ingest(varBatch{group: "agentic", generation: 4, revision: "sha256:type", values: wrongType}, "test"); err == nil {
		t.Fatalf("expected type rejection")
	}

	// LKG retained: still the good revision
	snap, ok := runtime.VarSnapshot("agentic.lanes.vinci")
	if !ok || snap.Revision != "sha256:good" || snap.Generation != 1 {
		t.Fatalf("LKG not retained: %+v", snap)
	}
	// rejection recorded in status without leaking values
	status := runtime.VarStatus()
	entry := status["agentic.lanes.vinci"]
	if entry.LastRejected == nil || entry.LastRejected.Revision != "sha256:type" {
		t.Fatalf("expected last rejected recorded, got %+v", entry.LastRejected)
	}
}

// --- #9 restart recovery: prefetch refetch on boot ---

func TestVarRestartRefetchesHead(t *testing.T) {
	t.Parallel()
	server := newFakeVarServer()
	server.activate(map[string]any{"user.plan": "pro"}, "sha256:head")
	httpServer := httptest.NewServer(server.handler())
	defer httpServer.Close()

	projection := baseVarProjection()
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: httpServer.URL}}
	projection.Vars = map[string]VarGroupDef{"user": {Source: "svc", Mode: "prefetch", TTL: "1h"}}

	// Simulate a fresh boot: new runtime, StartVars re-fetches the active head.
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()
	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("StartVars: %v", err)
	}
	if value, _, _ := runtime.Var("user.plan"); value != "pro" {
		t.Fatalf("restart did not recover head, got %v", value)
	}
}

func TestVarRequiredPrefetchFailsReady(t *testing.T) {
	t.Parallel()
	server := newFakeVarServer() // no head, no static, required → Ready must fail
	httpServer := httptest.NewServer(server.handler())
	defer httpServer.Close()

	projection := baseVarProjection()
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: httpServer.URL}}
	projection.Vars = map[string]VarGroupDef{"agentic": {Source: "svc", Mode: "prefetch"}}
	projection.Schema = map[string]VarKeyRule{"var.agentic.lanes.vinci": {Required: true}}

	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()
	err := runtime.StartVars(context.Background())
	if err == nil {
		t.Fatalf("expected StartVars to fail for unresolved required var")
	}
}

// --- #10 network loss serves LKG within window; #11 expired visible ---

func TestVarNetworkLossServesLKG(t *testing.T) {
	t.Parallel()
	server := newFakeVarServer()
	server.activate(map[string]any{"user.plan": "pro"}, "sha256:rev1")
	httpServer := httptest.NewServer(server.handler())
	defer httpServer.Close()

	projection := baseVarProjection()
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: httpServer.URL}}
	projection.Vars = map[string]VarGroupDef{"user": {Source: "svc", Mode: "prefetch", TTL: "1h", Lease: "1h"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()
	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("StartVars: %v", err)
	}

	// Network loss: server now errors. A manual refresh fails, LKG is retained.
	server.setFailure(http.StatusInternalServerError, "store-unsupported")
	_ = runtime.RefreshVars(context.Background())
	value, ok, _ := runtime.Var("user.plan")
	if !ok || value != "pro" {
		t.Fatalf("expected LKG pro after network loss, got ok=%v value=%v", ok, value)
	}
	snap, _ := runtime.VarSnapshot("user.plan")
	if snap.Freshness != FreshnessFresh {
		t.Fatalf("within window should be fresh, got %v", snap.Freshness)
	}
}

func TestVarFreshnessTransitions(t *testing.T) {
	t.Parallel()
	base := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		name   string
		ttl    time.Duration
		lease  time.Duration
		age    time.Duration
		expect Freshness
	}{
		{"fresh within ttl", time.Minute, 10 * time.Minute, 30 * time.Second, FreshnessFresh},
		{"stale past ttl before lease", time.Minute, 10 * time.Minute, 5 * time.Minute, FreshnessStale},
		{"expired past lease", time.Minute, 10 * time.Minute, 11 * time.Minute, FreshnessExpired},
		{"lease-only fresh", 0, 10 * time.Minute, 5 * time.Minute, FreshnessFresh},
		{"lease-only expired", 0, 10 * time.Minute, 11 * time.Minute, FreshnessExpired},
		{"ttl-only stale never expires", time.Minute, 0, time.Hour, FreshnessStale},
	}
	for _, tc := range cases {
		now := base.Add(tc.age)
		got, _ := computeFreshness(VarSourceRuntime, base, tc.ttl, tc.lease, now)
		if got != tc.expect {
			t.Errorf("%s: expected %v, got %v", tc.name, tc.expect, got)
		}
	}
	// static/default never expire
	if got, _ := computeFreshness(VarSourceStatic, base, time.Minute, time.Minute, base.Add(time.Hour)); got != FreshnessFresh {
		t.Errorf("static should stay fresh, got %v", got)
	}
}

func TestVarExpiredStateVisibleInStatus(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Vars = map[string]VarGroupDef{"user": {Mode: "ondemand", Lease: "10ms"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()
	variables := runtime.vars

	// Commit a record with a backdated ObservedAt so it is already expired.
	variables.store.commit(map[string]*varRecord{
		"var.user.plan": {
			base:  Snapshot{Key: "var.user.plan", Value: "pro", Generation: 1, Revision: "sha256:x", Source: VarSourceRuntime, ObservedAt: time.Now().Add(-time.Hour)},
			lease: 10 * time.Millisecond,
		},
	})
	snap, _ := runtime.VarSnapshot("user.plan")
	if snap.Freshness != FreshnessExpired {
		t.Fatalf("expected expired, got %v", snap.Freshness)
	}
	status := runtime.VarStatus()
	if status["user.plan"].Freshness != FreshnessExpired {
		t.Fatalf("status should report expired, got %v", status["user.plan"].Freshness)
	}
}

// --- #13 no secrets in status/logs ---

func TestVarStatusHasNoSecretMaterial(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Vars = map[string]VarGroupDef{"user": {Mode: "ondemand"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()
	_ = runtime.vars.ingest(varBatch{group: "user", generation: 1, revision: "sha256:r", values: map[string]any{"user.token_hint": "opaque-value-123"}}, "test")

	status := runtime.VarStatus()
	encoded, _ := json.Marshal(status)
	if strings.Contains(string(encoded), "opaque-value-123") {
		t.Fatalf("status must not contain var values: %s", encoded)
	}
	// status carries the revision hash and generation for observability
	if status["user.token_hint"].Revision != "sha256:r" {
		t.Fatalf("status should carry revision hash")
	}
}

// --- ondemand: first read serves fallback + triggers one background fetch ---

func TestVarOndemandServesFallbackAndFetchesOnce(t *testing.T) {
	t.Parallel()
	server := newFakeVarServer()
	server.activate(map[string]any{"user.plan": "pro"}, "sha256:rev1")
	httpServer := httptest.NewServer(server.handler())
	defer httpServer.Close()

	projection := baseVarProjection()
	projection.Values["user.plan"] = "free" // static fallback
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: httpServer.URL}}
	projection.Vars = map[string]VarGroupDef{"user": {Source: "svc", Mode: "ondemand", TTL: "1h"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	// First sync read serves the static fallback immediately.
	if value, _, _ := runtime.Var("user.plan"); value != "free" {
		t.Fatalf("first read should serve static fallback, got %v", value)
	}
	// Background fetch converges to the runtime value.
	if !waitFor(t, 2*time.Second, func() bool {
		value, _, _ := runtime.Var("user.plan")
		return value == "pro"
	}) {
		t.Fatalf("ondemand background fetch did not converge")
	}
}

// --- watch fire + stop ---

func TestVarWatchFiresAndStops(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Vars = map[string]VarGroupDef{"user": {Mode: "ondemand"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()
	variables := runtime.vars

	var fires int64
	var lastNext, lastPrev atomic.Value
	lastNext.Store("")
	lastPrev.Store("")
	stop := runtime.Watch("var.user.*", func(next, prev Snapshot) {
		atomic.AddInt64(&fires, 1)
		if v, ok := next.Value.(string); ok {
			lastNext.Store(v)
		}
		if v, ok := prev.Value.(string); ok {
			lastPrev.Store(v)
		}
	})

	_ = variables.ingest(varBatch{group: "user", generation: 1, revision: "r1", values: map[string]any{"user.plan": "free"}}, "test")
	_ = variables.ingest(varBatch{group: "user", generation: 2, revision: "r2", values: map[string]any{"user.plan": "pro"}}, "test")
	if atomic.LoadInt64(&fires) != 2 {
		t.Fatalf("expected 2 fires, got %d", fires)
	}
	if lastNext.Load() != "pro" || lastPrev.Load() != "free" {
		t.Fatalf("watch payload wrong: next=%v prev=%v", lastNext.Load(), lastPrev.Load())
	}

	stop()
	_ = variables.ingest(varBatch{group: "user", generation: 3, revision: "r3", values: map[string]any{"user.plan": "enterprise"}}, "test")
	if atomic.LoadInt64(&fires) != 2 {
		t.Fatalf("watch fired after stop: %d", fires)
	}
}

// --- Close is leak-free ---

func TestVarCloseIsLeakFree(t *testing.T) {
	server := newFakeVarServer()
	server.activate(map[string]any{"user.plan": "pro"}, "sha256:rev1")
	httpServer := httptest.NewServer(server.handler())
	defer httpServer.Close()

	before := goruntime.NumGoroutine()

	projection := baseVarProjection()
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: httpServer.URL, PollInterval: "10ms"}}
	projection.Vars = map[string]VarGroupDef{"user": {Source: "svc", Mode: "prefetch", TTL: "1h"}}
	runtime := loadVarRuntime(t, projection, nil)
	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("StartVars: %v", err)
	}
	time.Sleep(50 * time.Millisecond) // let the poller run a few cycles
	if err := runtime.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	_ = runtime.Close() // idempotent

	if !waitFor(t, 2*time.Second, func() bool {
		return goruntime.NumGoroutine() <= before+1
	}) {
		t.Fatalf("goroutines leaked: before=%d after=%d", before, goruntime.NumGoroutine())
	}
}

// --- snapshot Decode typed round-trip ---

func TestVarSnapshotDecode(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Vars = map[string]VarGroupDef{"agentic": {Mode: "ondemand"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()
	_ = runtime.vars.ingest(varBatch{group: "agentic", generation: 1, revision: "r", values: map[string]any{
		"agentic.lanes.vinci": map[string]any{"enabled": true, "target": "m1"},
	}}, "test")

	snap, ok := runtime.VarSnapshot("agentic.lanes.vinci")
	if !ok {
		t.Fatalf("snapshot missing")
	}
	var policy struct {
		Enabled bool   `json:"enabled"`
		Target  string `json:"target"`
	}
	if err := snap.Decode(&policy); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !policy.Enabled || policy.Target != "m1" {
		t.Fatalf("decoded wrong: %+v", policy)
	}
}

// --- RefreshVar honors ttl (fetch-if-stale) ---

func TestVarRefreshVarHonorsTTL(t *testing.T) {
	t.Parallel()
	server := newFakeVarServer()
	server.activate(map[string]any{"user.plan": "pro"}, "sha256:rev1")
	httpServer := httptest.NewServer(server.handler())
	defer httpServer.Close()

	projection := baseVarProjection()
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: httpServer.URL}}
	projection.Vars = map[string]VarGroupDef{"user": {Source: "svc", Mode: "ondemand", TTL: "1h"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	if err := runtime.RefreshVar(context.Background(), "user.plan"); err != nil {
		t.Fatalf("first refresh: %v", err)
	}
	countAfterFirst := atomic.LoadInt64(&server.requests)
	// Snapshot is fresh (ttl 1h) → refresh should be a no-op, no new request.
	if err := runtime.RefreshVar(context.Background(), "user.plan"); err != nil {
		t.Fatalf("second refresh: %v", err)
	}
	if atomic.LoadInt64(&server.requests) != countAfterFirst {
		t.Fatalf("fresh snapshot should not refetch")
	}
}

// --- derived expressions referencing var.* are runtime-dependent (never cached) ---

func TestVarDerivedReferenceIsRuntimeDependent(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Values["user.name"] = "a" // static fallback for var.user.name
	projection.Derived = map[string]DerivedFormula{
		"greeting": {Expr: "concat('hi-', var.user.name)", Deps: []string{"var.user.name"}},
	}
	projection.Vars = map[string]VarGroupDef{"user": {Mode: "ondemand"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	if value, _, _ := runtime.Value("greeting"); value != "hi-a" {
		t.Fatalf("expected hi-a (static var fallback), got %v", value)
	}
	// Activate a runtime var value; the derived read must reflect it (not cached).
	_ = runtime.vars.ingest(varBatch{group: "user", generation: 1, revision: "r", values: map[string]any{"user.name": "b"}}, "test")
	if value, _, _ := runtime.Value("greeting"); value != "hi-b" {
		t.Fatalf("derived referencing var.* was cached; expected hi-b, got %v", value)
	}

	// Confirm the formula is flagged runtime-dependent.
	entry := runtime.entries["value.greeting"]
	if entry == nil || entry.formula == nil || !entry.formula.runtimeDependent {
		t.Fatalf("derived formula should be runtime-dependent")
	}
}

// --- helpers ---

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return condition()
}
