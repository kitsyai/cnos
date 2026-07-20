package cnos

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// W5b test hardening for the Go var.* consumer SDK: freshness/lease boundaries,
// receiver adversarial input, replay/ordering semantics, cross-SDK divergences from
// the Node SDK, security regressions, and a var-less regression sweep.
//
// Tests named "Pinned" encode current behavior the design doc left unspecified.
// Tests named "Divergence" record a place where the Go and Node SDKs differ today.

// --- helpers ---------------------------------------------------------------

func pushRuntime(t *testing.T, groups map[string]VarGroupDef, rules map[string]VarKeyRule, verify bool) (*Runtime, string) {
	t.Helper()
	projection := baseVarProjection()
	source := VarSourceDef{Transport: "http", URL: "http://unused"}
	env := map[string]string{}
	if verify {
		projection.SecretRefs["ops.verify"] = SecretReference{Provider: "environment", Vault: "env", Ref: "ops.verify", EnvVar: "OPS_VERIFY"}
		source.Verify = "secret.ops.verify"
		env["OPS_VERIFY"] = "push-secret"
	}
	projection.VarSources = map[string]VarSourceDef{"svc": source}
	projection.Vars = groups
	if rules != nil {
		projection.Schema = rules
	}

	runtime := loadVarRuntime(t, projection, env)
	mux := http.NewServeMux()
	mux.Handle("/cnos/vars/", runtime.VarReceiver("svc"))
	server := httptest.NewServer(mux)
	t.Cleanup(func() {
		server.Close()
		runtime.Close()
	})
	return runtime, server.URL
}

func pushBearer(t *testing.T, url, body string) int {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer push-secret")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	defer response.Body.Close()
	return response.StatusCode
}

func pushSigned(t *testing.T, url, body string) int {
	t.Helper()
	mac := hmac.New(sha256.New, []byte("push-secret"))
	mac.Write([]byte(body))
	request, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	request.Header.Set("X-CNOS-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	defer response.Body.Close()
	return response.StatusCode
}

// --- freshness / lease boundaries ------------------------------------------

func TestVarFreshnessBoundaryIsStrictlyGreaterThan(t *testing.T) {
	t.Parallel()
	observed := time.Unix(0, 0)
	ttl := 100 * time.Millisecond
	lease := 500 * time.Millisecond

	cases := []struct {
		age  time.Duration
		want Freshness
	}{
		{0, FreshnessFresh},
		{ttl, FreshnessFresh},                   // exactly at the ttl edge is still fresh
		{ttl + time.Nanosecond, FreshnessStale}, // one tick past
		{lease, FreshnessStale},                 // exactly at the lease edge is still stale
		{lease + time.Nanosecond, FreshnessExpired},
	}
	for _, testCase := range cases {
		got, _ := computeFreshness(VarSourceRuntime, observed, ttl, lease, true, observed.Add(testCase.age))
		if got != testCase.want {
			t.Fatalf("age %v: expected %v, got %v", testCase.age, testCase.want, got)
		}
	}
}

func TestVarFreshnessNoWindowsNeverAgesOut(t *testing.T) {
	t.Parallel()
	observed := time.Unix(0, 0)
	got, expires := computeFreshness(VarSourceRuntime, observed, 0, 0, false, observed.Add(1000*time.Hour))
	if got != FreshnessFresh {
		t.Fatalf("with no ttl/lease expected fresh forever, got %v", got)
	}
	if expires != nil {
		t.Fatalf("expected no leaseExpiresAt without a lease, got %v", expires)
	}
}

func TestVarFreshnessStaticAndDefaultTiersNeverExpire(t *testing.T) {
	t.Parallel()
	observed := time.Unix(0, 0)
	for _, source := range []VarSource{VarSourceStatic, VarSourceDefault} {
		got, expires := computeFreshness(source, observed, time.Millisecond, time.Millisecond, true, observed.Add(time.Hour))
		if got != FreshnessFresh || expires != nil {
			t.Fatalf("source %v: expected fresh/no-expiry, got %v/%v", source, got, expires)
		}
	}
}

func TestVarFreshnessClockSkewObservedInFuture(t *testing.T) {
	t.Parallel()
	// Pinned: a negative age (wall clock jumped backwards) reports fresh rather than
	// wrapping into stale/expired.
	observed := time.Unix(1000, 0)
	got, _ := computeFreshness(VarSourceRuntime, observed, time.Millisecond, time.Millisecond, true, time.Unix(0, 0))
	if got != FreshnessFresh {
		t.Fatalf("expected fresh under negative age, got %v", got)
	}
}

func TestVarFreshnessZeroLeaseExpiresImmediately(t *testing.T) {
	t.Parallel()
	// W5d/D9 CANONICAL (both SDKs): an ABSENT lease never expires; an explicitly declared
	// `lease: 0` expires immediately. Presence is carried by the leaseSet flag, derived from
	// the manifest duration STRING, so it survives the parse the way `default`-presence does.
	observed := time.Unix(0, 0)

	got, expires := computeFreshness(VarSourceRuntime, observed, 0, 0, false, observed.Add(time.Hour))
	if got != FreshnessFresh {
		t.Fatalf("absent lease must never expire, got %v", got)
	}
	if expires != nil {
		t.Fatalf("absent lease must emit no leaseExpiresAt, got %v", expires)
	}

	got, expires = computeFreshness(VarSourceRuntime, observed, 0, 0, true, observed.Add(time.Nanosecond))
	if got != FreshnessExpired {
		t.Fatalf("a declared zero lease must expire on the next tick, got %v", got)
	}
	if expires == nil || !expires.Equal(observed) {
		t.Fatalf("a declared zero lease must expire AT observedAt, got %v", expires)
	}
	// At exactly age 0 it is still fresh — the boundary is strictly-greater-than, as elsewhere.
	if got, _ := computeFreshness(VarSourceRuntime, observed, 0, 0, true, observed); got != FreshnessFresh {
		t.Fatalf("a declared zero lease at age 0 should still be fresh, got %v", got)
	}
}

func TestVarZeroLeaseFromManifestExpiresImmediately(t *testing.T) {
	t.Parallel()
	// End-to-end: `lease: "0s"` in the projection must reach the record as leaseSet=true.
	runtime, _ := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand", Lease: "0s"}}, nil, false)
	if err := runtime.vars.ingest(varBatch{group: "user", generation: 1, revision: "sha256:one", values: map[string]any{"user.plan": "pro"}}, "test"); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	time.Sleep(2 * time.Millisecond)
	snapshot, _ := runtime.VarSnapshot("user.plan")
	if snapshot.Freshness != FreshnessExpired {
		t.Fatalf("a declared zero lease should report expired, got %v", snapshot.Freshness)
	}
}

// --- ordering / replay semantics -------------------------------------------

func TestVarPinnedOutOfOrderIngestIsLastWriteWins(t *testing.T) {
	t.Parallel()
	// PINNED: `ingest` performs no generation/revision ordering check, so a lower
	// generation arriving after a higher one overwrites it. Matches the Node SDK.
	runtime, _ := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, nil, false)

	if err := runtime.vars.ingest(varBatch{group: "user", generation: 99, revision: "sha256:new", values: map[string]any{"user.plan": "newer"}}, "test"); err != nil {
		t.Fatalf("ingest newer: %v", err)
	}
	if err := runtime.vars.ingest(varBatch{group: "user", generation: 2, revision: "sha256:old", values: map[string]any{"user.plan": "older"}}, "test"); err != nil {
		t.Fatalf("ingest older: %v", err)
	}

	value, _, _ := runtime.Var("user.plan")
	if value != "older" {
		t.Fatalf("expected last-write-wins (older), got %v", value)
	}
	snapshot, _ := runtime.VarSnapshot("user.plan")
	if snapshot.Generation != 2 {
		t.Fatalf("expected generation 2 after the out-of-order write, got %d", snapshot.Generation)
	}
	// W5d/D9 CANONICAL (both SDKs): status is keyed by the prefix-stripped FULL KEY, the
	// same keying every wire `values` payload uses. The Node SDK was fixed to match.
	if status := runtime.VarStatus()["user.plan"]; status.AppliedGeneration != 2 {
		t.Fatalf("expected applied generation 2 in status, got %d", status.AppliedGeneration)
	}
}

func TestVarReplayedIdenticalBatchIsSilent(t *testing.T) {
	t.Parallel()
	// W5d/D9 CANONICAL (both SDKs): watcher dispatch is gated on the content-addressed
	// revision alone, so replaying an already-applied document wakes nobody. Idempotent push
	// is a core protocol property, and generation is excluded deliberately: a revision-less
	// push is stamped with a wall-clock generation, so gating on it would wake every watcher
	// on each identical replay. (A same-revision commit at a new generation stays silent —
	// asserted below; only a content change fires.)
	runtime, _ := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, nil, false)

	var mu sync.Mutex
	fires := 0
	stop := runtime.Watch("var.user.plan", func(next, prev Snapshot) {
		mu.Lock()
		fires++
		mu.Unlock()
	})
	defer stop()

	batch := varBatch{group: "user", generation: 5, revision: "sha256:same", values: map[string]any{"user.plan": "pro"}}
	for i := 0; i < 3; i++ {
		if err := runtime.vars.ingest(batch, "test"); err != nil {
			t.Fatalf("ingest %d: %v", i, err)
		}
	}

	mu.Lock()
	got := fires
	mu.Unlock()
	if got != 1 {
		t.Fatalf("an exact replay must not wake watchers; expected 1 fire, got %d", got)
	}

	// A new generation carrying the SAME revision is unchanged content: still silent.
	bumped := batch
	bumped.generation = 6
	if err := runtime.vars.ingest(bumped, "test"); err != nil {
		t.Fatalf("ingest bumped: %v", err)
	}
	mu.Lock()
	got = fires
	mu.Unlock()
	if got != 1 {
		t.Fatalf("unchanged content must stay silent; expected 1 fire, got %d", got)
	}

	// A genuine content change fires.
	changed := varBatch{group: "user", generation: 7, revision: "sha256:different", values: map[string]any{"user.plan": "free"}}
	if err := runtime.vars.ingest(changed, "test"); err != nil {
		t.Fatalf("ingest changed: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if fires != 2 {
		t.Fatalf("a content change must fire; expected 2 fires, got %d", fires)
	}
}

func TestVarLastKnownGoodPointsAtPriorRevision(t *testing.T) {
	t.Parallel()
	// W5d/D9 CANONICAL (both SDKs): LastKnownGood names the last revision that was
	// successfully validated and served while fresh — i.e. the revision this commit
	// DISPLACED. Stamped at commit time from the outgoing snapshot, absent on a scope's
	// first commit, independent of the current freshness. The Node SDK was fixed to match
	// (it used to echo the snapshot's OWN gen/rev, and only once not fresh).
	runtime, _ := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, nil, false)

	_ = runtime.vars.ingest(varBatch{group: "user", generation: 1, revision: "sha256:one", values: map[string]any{"user.plan": "free"}}, "test")
	first, _ := runtime.VarSnapshot("user.plan")
	if first.LastKnownGood != nil {
		t.Fatalf("first commit should carry no LastKnownGood, got %+v", first.LastKnownGood)
	}

	_ = runtime.vars.ingest(varBatch{group: "user", generation: 2, revision: "sha256:two", values: map[string]any{"user.plan": "pro"}}, "test")
	second, _ := runtime.VarSnapshot("user.plan")
	if second.LastKnownGood == nil || second.LastKnownGood.Revision != "sha256:one" || second.LastKnownGood.Generation != 1 {
		t.Fatalf("expected LastKnownGood to point at the PRIOR revision, got %+v", second.LastKnownGood)
	}
}

func TestVarInvalidBatchCommitsNothing(t *testing.T) {
	t.Parallel()
	// Acceptance #3/#5: a batch whose LAST key is invalid must not commit its earlier keys.
	rules := map[string]VarKeyRule{
		"var.user.plan":  {Type: "string"},
		"var.user.limit": {Type: "number"},
	}
	runtime, _ := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, rules, false)

	_ = runtime.vars.ingest(varBatch{group: "user", generation: 1, revision: "sha256:good", values: map[string]any{"user.plan": "free", "user.limit": float64(10)}}, "test")

	err := runtime.vars.ingest(varBatch{
		group:      "user",
		generation: 2,
		revision:   "sha256:bad",
		values:     map[string]any{"user.plan": "pro", "user.limit": "not-a-number"},
	}, "test")
	if err == nil {
		t.Fatalf("expected the mixed batch to be rejected")
	}

	if value, _, _ := runtime.Var("user.plan"); value != "free" {
		t.Fatalf("last-known-good lost for user.plan: %v", value)
	}
	if value, _, _ := runtime.Var("user.limit"); value != float64(10) {
		t.Fatalf("last-known-good lost for user.limit: %v", value)
	}
	if status := runtime.VarStatus()["user.limit"]; status.LastRejected == nil {
		t.Fatalf("expected a lastRejected record in status")
	}
}

// --- receiver adversarial input --------------------------------------------

func TestVarReceiverRejectsNonPost(t *testing.T) {
	t.Parallel()
	_, base := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, nil, true)

	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		request, _ := http.NewRequest(method, base+"/cnos/vars/user", nil)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("%s: expected 405, got %d", method, response.StatusCode)
		}
	}
}

func TestVarReceiverRejectsMalformedBodies(t *testing.T) {
	t.Parallel()
	_, base := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, nil, true)

	// Truncated / non-object / missing-values payloads must all be 400 bad-payload.
	for _, body := range []string{`{`, `{"values":`, `[1,2`, `nope`, `{}`, `{"values":null}`, `null`, `[]`, `"str"`, `42`} {
		if status := pushSigned(t, base+"/cnos/vars/user", body); status != http.StatusBadRequest {
			t.Fatalf("body %q: expected 400, got %d", body, status)
		}
	}
}

func TestVarReceiverPinnedValuesArrayIsRejected(t *testing.T) {
	t.Parallel()
	_, base := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, nil, true)
	// `values` typed as map[string]any — an array body fails to unmarshal → 400.
	if status := pushSigned(t, base+`/cnos/vars/user`, `{"values":[1,2,3]}`); status != http.StatusBadRequest {
		t.Fatalf("expected 400 for array values, got %d", status)
	}
}

func TestVarReceiverUnknownSourceIs404(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.VarSources = map[string]VarSourceDef{"svc": {Transport: "http", URL: "http://unused"}}
	projection.Vars = map[string]VarGroupDef{"user": {Source: "svc", Mode: "ondemand"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	mux := http.NewServeMux()
	mux.Handle("/cnos/vars/", runtime.VarReceiver("does-not-exist"))
	server := httptest.NewServer(mux)
	defer server.Close()

	response, err := http.Post(server.URL+"/cnos/vars/user", "application/json", strings.NewReader(`{"values":{}}`))
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for an unknown source, got %d", response.StatusCode)
	}
}

func TestVarReceiverPinnedFailsClosedWithoutVerifySecret(t *testing.T) {
	t.Parallel()
	// PINNED: unlike the Node receiver (which skips verification entirely when a source
	// declares no `verify` ref), the Go receiver fails CLOSED with 401. See the W5b report.
	_, base := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, nil, false)

	response, err := http.Post(base+"/cnos/vars/user", "application/json", strings.NewReader(`{"values":{"user.plan":"pro"}}`))
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for a source with no verify secret, got %d", response.StatusCode)
	}
}

func TestVarReceiverPinnedBodyLimitIsOneMiB(t *testing.T) {
	// Not parallel: allocates several MiB.
	// W5d/D3 CANONICAL (both SDKs): the receiver caps the inbound body at 1 MiB and rejects
	// anything larger with 413 payload-too-large — DETECTED, not silently truncated into a
	// signature mismatch (which is what the old io.LimitReader(1<<20) produced). The Node
	// receiver now enforces the same cap and returns the same status.
	_, base := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, nil, true)

	oversized := fmt.Sprintf(`{"values":{"user.blob":%q}}`, strings.Repeat("q", 2*1024*1024))
	if status := pushSigned(t, base+"/cnos/vars/user", oversized); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for a >1MiB body, got %d", status)
	}

	// A body comfortably under the limit still commits.
	under := fmt.Sprintf(`{"values":{"user.blob":%q}}`, strings.Repeat("q", 512*1024))
	if status := pushSigned(t, base+"/cnos/vars/user", under); status != http.StatusNoContent {
		t.Fatalf("expected 204 for a sub-limit body, got %d", status)
	}
}

func TestVarReceiverSignatureEdgeCases(t *testing.T) {
	t.Parallel()
	_, base := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, nil, true)
	body := `{"values":{"user.plan":"pro"}}`
	mac := hmac.New(sha256.New, []byte("push-secret"))
	mac.Write([]byte(body))
	digest := hex.EncodeToString(mac.Sum(nil))

	for _, signature := range []string{digest, "sha1=" + digest, "sha256:" + digest, "SHA256=" + digest, "sha256=" + digest[:10], "sha256="} {
		request, _ := http.NewRequest(http.MethodPost, base+"/cnos/vars/user", strings.NewReader(body))
		request.Header.Set("X-CNOS-Signature", signature)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("push: %v", err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("signature %q: expected 401, got %d", signature, response.StatusCode)
		}
	}
}

func TestVarReceiverSignaturePresenceDecidesTheScheme(t *testing.T) {
	t.Parallel()
	// W5d/D9 CANONICAL (both SDKs): scheme selection is PRESENCE-based. If a signature
	// header is present the signature decides — a valid signature wins even alongside a
	// wrong bearer, and a wrong signature is a 401 even alongside a VALID bearer. Only when
	// the header is absent does the bearer decide. One rule, no silent either-or acceptance.
	_, base := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, nil, true)
	body := `{"values":{"user.plan":"pro"}}`
	mac := hmac.New(sha256.New, []byte("push-secret"))
	mac.Write([]byte(body))
	valid := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	cases := []struct {
		name      string
		bearer    string
		signature string
		want      int
	}{
		{"valid signature beats a wrong bearer", "Bearer wrong-token", valid, http.StatusNoContent},
		{"wrong signature loses to a valid bearer", "Bearer push-secret", "sha256=deadbeef", http.StatusUnauthorized},
		{"bearer decides when no signature header is present", "Bearer push-secret", "", http.StatusNoContent},
	}

	for _, testCase := range cases {
		request, _ := http.NewRequest(http.MethodPost, base+"/cnos/vars/user", strings.NewReader(body))
		request.Header.Set("Authorization", testCase.bearer)
		if testCase.signature != "" {
			request.Header.Set("X-CNOS-Signature", testCase.signature)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("%s: push: %v", testCase.name, err)
		}
		response.Body.Close()
		if response.StatusCode != testCase.want {
			t.Fatalf("%s: expected %d, got %d", testCase.name, testCase.want, response.StatusCode)
		}
	}
}

func TestVarReceiverPushDefaultsAndRoundTrip(t *testing.T) {
	t.Parallel()
	runtime, base := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, nil, true)
	before := time.Now().UnixMilli()

	if status := pushBearer(t, base+"/cnos/vars/user", `{"values":{"user.plan":"pro"}}`); status != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", status)
	}

	snapshot, ok := runtime.VarSnapshot("user.plan")
	if !ok {
		t.Fatalf("expected a runtime snapshot after the push")
	}
	if !strings.HasPrefix(snapshot.Revision, "sha256:") || len(snapshot.Revision) != len("sha256:")+64 {
		t.Fatalf("expected a derived sha256 revision, got %q", snapshot.Revision)
	}
	if snapshot.Generation < before || snapshot.Generation > time.Now().UnixMilli() {
		t.Fatalf("expected a unix-millis generation, got %d", snapshot.Generation)
	}
}

func TestVarReceiverRejectsSchemaViolationAndKeepsLKG(t *testing.T) {
	t.Parallel()
	rules := map[string]VarKeyRule{"var.user.enabled": {Type: "boolean", HasDefault: true, Default: false}}
	runtime, base := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, rules, true)

	if status := pushBearer(t, base+"/cnos/vars/user", `{"values":{"user.enabled":true}}`); status != http.StatusNoContent {
		t.Fatalf("seed push failed")
	}
	if status := pushBearer(t, base+"/cnos/vars/user", `{"values":{"user.enabled":"nope"}}`); status != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for a schema violation, got %d", status)
	}
	if value, _, _ := runtime.Var("user.enabled"); value != true {
		t.Fatalf("last-known-good not retained, got %v", value)
	}
}

func TestVarReceiverScopeFromPathEdgeCases(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"/cnos/vars/user":        "user",
		"/cnos/vars/user.plan":   "user.plan",
		"/api/v2/cnos/vars/user": "user",
		"/cnos/vars/user/":       "user",
		"/custom/mount/user":     "user",
		"user":                   "user",
		"/cnos/vars/グループ.日本":     "グループ.日本",
		"/cnos/vars/a/b":         "a/b", // PINNED: everything after the marker, slashes included
	}
	for path, want := range cases {
		if got := scopeFromPath(path); got != want {
			t.Fatalf("scopeFromPath(%q) = %q, want %q", path, got, want)
		}
	}
}

// --- security regressions ---------------------------------------------------

const goSecretLiteral = "SUPER-SECRET-MATERIAL-9f3a"

func TestVarSecurityNoSecretMaterialInStatusOrProjection(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.SecretRefs["ops.verify"] = SecretReference{Provider: "environment", Vault: "env", Ref: "ops.verify", EnvVar: "OPS_VERIFY"}
	projection.SecretRefs["ops.token"] = SecretReference{Provider: "environment", Vault: "env", Ref: "ops.token", EnvVar: "OPS_TOKEN"}
	projection.VarSources = map[string]VarSourceDef{
		"svc": {Transport: "http", URL: "http://unused", Verify: "secret.ops.verify", Auth: map[string]string{"bearer": "secret.ops.token"}},
	}
	projection.Vars = map[string]VarGroupDef{"user": {Source: "svc", Mode: "ondemand"}}
	projection.Schema = map[string]VarKeyRule{"var.user.ref": {Type: "string"}}

	runtime := loadVarRuntime(t, projection, map[string]string{
		"OPS_VERIFY": goSecretLiteral,
		"OPS_TOKEN":  goSecretLiteral,
	})
	defer runtime.Close()

	// A var document may carry an opaque secret.* REF; it must never be dereferenced.
	_ = runtime.vars.ingest(varBatch{group: "user", generation: 1, revision: "sha256:r", values: map[string]any{"user.ref": "secret.ops.token"}}, "test")
	if value, _, _ := runtime.Var("user.ref"); value != "secret.ops.token" {
		t.Fatalf("secret ref was resolved into the document: %v", value)
	}

	encoded, err := json.Marshal(runtime.VarStatus())
	if err != nil {
		t.Fatalf("marshal status: %v", err)
	}
	if strings.Contains(string(encoded), goSecretLiteral) {
		t.Fatalf("secret material leaked into VarStatus(): %s", encoded)
	}
	if strings.Contains(string(encoded), "user.ref") || strings.Contains(string(encoded), "sha256:r") == false {
		// Status summarizes by revision, never by document body.
		t.Logf("status: %s", encoded)
	}
	if strings.Contains(string(encoded), `"values"`) {
		t.Fatalf("VarStatus() must not carry document values: %s", encoded)
	}
}

func TestVarSecurityRejectionReasonOmitsTheOffendingValue(t *testing.T) {
	t.Parallel()
	rules := map[string]VarKeyRule{"var.user.limit": {Type: "number"}}
	runtime, _ := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, rules, false)

	_ = runtime.vars.ingest(varBatch{group: "user", generation: 1, revision: "sha256:bad", values: map[string]any{"user.limit": goSecretLiteral}}, "test")

	status := runtime.VarStatus()["user.limit"]
	if status.LastRejected == nil {
		t.Fatalf("expected a lastRejected record")
	}
	if strings.Contains(status.LastRejected.Reason, goSecretLiteral) {
		t.Fatalf("rejection reason leaked the offending value: %s", status.LastRejected.Reason)
	}
}

func TestVarSecurityVarKeysNeverReachPublicSurfaces(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Vars = map[string]VarGroupDef{"user": {Mode: "ondemand"}}
	projection.Schema = map[string]VarKeyRule{"var.user.plan": {Type: "string"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	_ = runtime.vars.ingest(varBatch{group: "user", generation: 1, revision: "sha256:r", values: map[string]any{"user.plan": "runtime-only-value"}}, "test")
	if value, _, _ := runtime.Var("user.plan"); value != "runtime-only-value" {
		t.Fatalf("setup failed: %v", value)
	}

	// The public/browser surface is driven by PublicKeys, which never contains var.* keys.
	for _, key := range runtime.projection.PublicKeys {
		if strings.HasPrefix(key, "var.") {
			t.Fatalf("var.* key %q reached the public key set", key)
		}
	}
	encoded, err := json.Marshal(runtime.projection.Values)
	if err != nil {
		t.Fatalf("marshal values: %v", err)
	}
	if strings.Contains(string(encoded), "runtime-only-value") {
		t.Fatalf("runtime var value leaked into the projected values: %s", encoded)
	}
}

// --- derived re-evaluation (Critical Rule 9) --------------------------------

func TestVarDerivedReadIsReevaluatedAfterEveryPush(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Values["user.name"] = "static"
	projection.Derived = map[string]DerivedFormula{
		"greeting": {Expr: "concat('hi-', var.user.name)", Deps: []string{"var.user.name"}},
	}
	projection.Vars = map[string]VarGroupDef{"user": {Mode: "ondemand"}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	// Repeated pushes must each be reflected — proving nothing is memoized between reads.
	for index, name := range []string{"a", "b", "c", "a"} {
		_ = runtime.vars.ingest(varBatch{
			group:      "user",
			generation: int64(index + 1),
			revision:   fmt.Sprintf("sha256:r%d", index),
			values:     map[string]any{"user.name": name},
		}, "test")
		value, _, _ := runtime.Value("greeting")
		if value != "hi-"+name {
			t.Fatalf("push %d: expected hi-%s, got %v", index, name, value)
		}
		// Reading twice in a row must not freeze the value either.
		if again, _, _ := runtime.Value("greeting"); again != value {
			t.Fatalf("push %d: repeated read diverged: %v vs %v", index, value, again)
		}
	}
}

// --- regression sweep: var-less projections unchanged ------------------------

func TestRegressionVarlessProjectionHasNoVarRuntime(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	projection.Values["server.port"] = float64(8080)
	// No VarSources / Vars / Schema blocks at all — the pre-var shape.
	runtime := loadVarRuntime(t, projection, nil)

	if value, ok, _ := runtime.Value("server.port"); !ok || value != float64(8080) {
		t.Fatalf("static read regressed: ok=%v value=%v", ok, value)
	}
	if status := runtime.VarStatus(); len(status) != 0 {
		t.Fatalf("expected an empty var status on a var-less projection, got %+v", status)
	}
	if _, ok := runtime.VarSnapshot("anything.at.all"); ok {
		t.Fatalf("expected no snapshot on a var-less projection")
	}
	if _, ok, err := runtime.Var("anything.at.all"); ok || err != nil {
		t.Fatalf("expected a miss with no error, got ok=%v err=%v", ok, err)
	}
	if err := runtime.RefreshVars(context.Background()); err != nil {
		t.Fatalf("RefreshVars on a var-less runtime should be a no-op: %v", err)
	}
	// Close is a no-op and is safe to call twice.
	if err := runtime.Close(); err != nil {
		t.Fatalf("first close: %v", err)
	}
	if err := runtime.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
}

func TestRegressionVarlessProjectionJSONOmitsVarBlocks(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	encoded, err := json.Marshal(projection)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"varSources", "vars", "documents", "schema"} {
		if _, present := decoded[key]; present {
			t.Fatalf("var block %q must be omitted from a var-less projection: %s", key, encoded)
		}
	}
}

func TestRegressionVarlessRuntimeStartsNoGoroutinesOrTimers(t *testing.T) {
	t.Parallel()
	projection := baseVarProjection()
	runtime := loadVarRuntime(t, projection, nil)
	if err := runtime.StartVars(context.Background()); err != nil {
		t.Fatalf("StartVars on a var-less projection: %v", err)
	}
	if err := runtime.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

// --- key/scope edge cases ---------------------------------------------------

func TestVarUnicodeAndDeepKeys(t *testing.T) {
	t.Parallel()
	deep := "user." + strings.Repeat("s.", 200) + "leaf"
	rules := map[string]VarKeyRule{
		"var.user.日本": {Type: "string"},
		"var." + deep: {Type: "string"},
	}
	runtime, _ := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, rules, false)

	if err := runtime.vars.ingest(varBatch{
		group:      "user",
		generation: 1,
		revision:   "sha256:r",
		values:     map[string]any{"user.日本": "ようこそ", deep: "deep"},
	}, "test"); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if value, _, _ := runtime.Var("user.日本"); value != "ようこそ" {
		t.Fatalf("unicode key lost: %v", value)
	}
	if value, _, _ := runtime.Var(deep); value != "deep" {
		t.Fatalf("deep key lost: %v", value)
	}
}

func TestVarWatchPrefixAndExactMatching(t *testing.T) {
	t.Parallel()
	rules := map[string]VarKeyRule{"var.user.a": {Type: "string"}, "var.user.b": {Type: "string"}, "var.other.c": {Type: "string"}}
	runtime, _ := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}, "other": {Mode: "ondemand"}}, rules, false)

	var mu sync.Mutex
	prefixHits := map[string]int{}
	exactHits := 0

	stopPrefix := runtime.Watch("var.user.*", func(next, prev Snapshot) {
		mu.Lock()
		prefixHits[next.Key]++
		mu.Unlock()
	})
	defer stopPrefix()
	// A bare (prefix-less) spec is normalized with the `var.` prefix.
	stopExact := runtime.Watch("user.a", func(next, prev Snapshot) {
		mu.Lock()
		exactHits++
		mu.Unlock()
	})
	defer stopExact()

	_ = runtime.vars.ingest(varBatch{group: "user", generation: 1, revision: "sha256:r1", values: map[string]any{"user.a": "A", "user.b": "B"}}, "test")
	_ = runtime.vars.ingest(varBatch{group: "other", generation: 1, revision: "sha256:r2", values: map[string]any{"other.c": "C"}}, "test")

	mu.Lock()
	defer mu.Unlock()
	if prefixHits["var.user.a"] != 1 || prefixHits["var.user.b"] != 1 {
		t.Fatalf("prefix watcher hits: %+v", prefixHits)
	}
	if prefixHits["var.other.c"] != 0 {
		t.Fatalf("prefix watcher matched a non-matching group: %+v", prefixHits)
	}
	if exactHits != 1 {
		t.Fatalf("exact watcher expected 1 hit, got %d", exactHits)
	}
}

func TestVarWatchUnsubscribeIsIdempotent(t *testing.T) {
	t.Parallel()
	runtime, _ := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, nil, false)

	var mu sync.Mutex
	fires := 0
	stop := runtime.Watch("var.user.plan", func(next, prev Snapshot) {
		mu.Lock()
		fires++
		mu.Unlock()
	})
	stop()
	stop() // second call must be a safe no-op

	_ = runtime.vars.ingest(varBatch{group: "user", generation: 1, revision: "sha256:r", values: map[string]any{"user.plan": "pro"}}, "test")

	mu.Lock()
	defer mu.Unlock()
	if fires != 0 {
		t.Fatalf("expected no fires after unsubscribe, got %d", fires)
	}
}

func TestVarPanickingWatcherIsContained(t *testing.T) {
	t.Parallel()
	runtime, _ := pushRuntime(t, map[string]VarGroupDef{"user": {Mode: "ondemand"}}, nil, false)

	stop := runtime.Watch("var.user.plan", func(next, prev Snapshot) {
		panic("watcher boom")
	})
	defer stop()

	if err := runtime.vars.ingest(varBatch{group: "user", generation: 1, revision: "sha256:r", values: map[string]any{"user.plan": "pro"}}, "test"); err != nil {
		t.Fatalf("a panicking watcher must not fail the commit: %v", err)
	}
	if value, _, _ := runtime.Var("user.plan"); value != "pro" {
		t.Fatalf("commit lost after a panicking watcher: %v", value)
	}
}
