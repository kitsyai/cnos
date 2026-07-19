package cnos

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Cross-SDK wire fixtures shared with the TypeScript server/SDK. Its twin is
// packages/core/test/cross-sdk-wire.test.ts; both read the SAME JSON files under
// fixtures/var-cross-sdk/. If a wire shape changes, both tests move together.

func crossSDKFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "fixtures", "var-cross-sdk", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return data
}

// The shared projection fixture parses into ServerProjection with the canonical var
// blocks; `schema` rules carry document/required and track `default` presence.
func TestCrossSDKProjectionParses(t *testing.T) {
	t.Parallel()
	projection, err := ParseProjection(crossSDKFixture(t, "projection.json"))
	if err != nil {
		t.Fatalf("parse projection: %v", err)
	}

	if src, ok := projection.VarSources["ops"]; !ok || src.Transport != "http" || src.Verify != "secret.ops.verify" {
		t.Fatalf("varSources.ops mismatch: %+v", projection.VarSources)
	}
	if grp, ok := projection.Vars["agentic"]; !ok || grp.Mode != "prefetch" || grp.Lease != "10m" {
		t.Fatalf("vars.agentic mismatch: %+v", projection.Vars)
	}
	if _, ok := projection.Documents["agentic-lanes/v1"]; !ok {
		t.Fatalf("documents missing agentic-lanes/v1: %+v", projection.Documents)
	}

	// Required rule binds a document and declares NO default (HasDefault stays false).
	agentic, ok := projection.Schema["var.agentic.lanes.vinci"]
	if !ok || agentic.Document != "agentic-lanes/v1" || !agentic.Required {
		t.Fatalf("schema.agentic rule mismatch: %+v", agentic)
	}
	if agentic.HasDefault {
		t.Fatalf("required rule must not carry a default: %+v", agentic)
	}

	// Coupon rule declares a default of false — presence must round-trip (distinct from absent).
	coupon, ok := projection.Schema["var.user.IN.coupon_allowed"]
	if !ok || coupon.Type != "boolean" || !coupon.HasDefault || coupon.Default != false {
		t.Fatalf("schema.coupon rule mismatch: %+v", coupon)
	}
}

// The group-scoped pull response has `values` keyed by the full stripped key; the SDK
// ingests it and serves the wrapped document at that key.
func TestCrossSDKPullResponseIngest(t *testing.T) {
	t.Parallel()
	var body pullBody
	if err := json.Unmarshal(crossSDKFixture(t, "pull-response.json"), &body); err != nil {
		t.Fatalf("decode pull response: %v", err)
	}
	if _, ok := body.Values["agentic.lanes.vinci"]; !ok {
		t.Fatalf("pull values must be keyed by full stripped key, got: %+v", body.Values)
	}

	projection := baseVarProjection()
	projection.Vars = map[string]VarGroupDef{"agentic": {Source: "ops", Mode: "prefetch", Lease: "10m"}}
	projection.Documents = map[string]DocumentSchema{
		"agentic-lanes/v1": {
			Fields:               map[string]DocumentField{"enabled": {Type: "boolean", Required: true}, "model_target_ref": {Type: "string", Required: true}},
			AdditionalProperties: false,
		},
	}
	projection.Schema = map[string]VarKeyRule{"var.agentic.lanes.vinci": {Document: "agentic-lanes/v1", Required: true}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	if err := runtime.vars.ingest(varBatch{
		group:       "agentic",
		generation:  body.Generation,
		revision:    body.Revision,
		schemaId:    body.SchemaId,
		effectiveAt: body.EffectiveAt,
		values:      body.Values,
	}, "test"); err != nil {
		t.Fatalf("ingest pull response: %v", err)
	}

	value, ok, err := runtime.Var("agentic.lanes.vinci")
	if err != nil || !ok {
		t.Fatalf("read agentic.lanes.vinci: ok=%v err=%v", ok, err)
	}
	doc, isMap := value.(map[string]any)
	if !isMap || doc["enabled"] != true {
		t.Fatalf("unexpected ingested document: %+v", value)
	}
}

// The group-scoped push payload parses into receiverBody with full-key `values`.
func TestCrossSDKPushPayloadIngest(t *testing.T) {
	t.Parallel()
	var payload receiverBody
	if err := json.Unmarshal(crossSDKFixture(t, "push-payload.json"), &payload); err != nil {
		t.Fatalf("decode push payload: %v", err)
	}
	if _, ok := payload.Values["user.IN.coupon_allowed"]; !ok {
		t.Fatalf("push values must be keyed by full stripped key, got: %+v", payload.Values)
	}

	projection := baseVarProjection()
	projection.Vars = map[string]VarGroupDef{"user": {Source: "ops", Mode: "ondemand", TTL: "60s"}}
	projection.Schema = map[string]VarKeyRule{"var.user.IN.coupon_allowed": {Type: "boolean", HasDefault: true, Default: false}}
	runtime := loadVarRuntime(t, projection, nil)
	defer runtime.Close()

	if err := runtime.vars.ingest(varBatch{
		group:       "user",
		generation:  payload.Generation,
		revision:    payload.Revision,
		schemaId:    payload.SchemaId,
		effectiveAt: payload.EffectiveAt,
		values:      payload.Values,
	}, "test"); err != nil {
		t.Fatalf("ingest push payload: %v", err)
	}

	if value, _, _ := runtime.Var("user.IN.coupon_allowed"); value != true {
		t.Fatalf("expected coupon true, got %v", value)
	}
}

// The default push revision (when a payload omits `revision`) is sha256 of canonical
// JSON of `values` — identical bytes to the TS SDK.
func TestCrossSDKDefaultRevisionParity(t *testing.T) {
	t.Parallel()
	var fixture struct {
		Values           map[string]any `json:"values"`
		ExpectedRevision string         `json:"expectedRevision"`
	}
	if err := json.Unmarshal(crossSDKFixture(t, "default-revision.json"), &fixture); err != nil {
		t.Fatalf("decode default-revision fixture: %v", err)
	}
	if got := defaultVarRevision(fixture.Values); got != fixture.ExpectedRevision {
		t.Fatalf("default revision mismatch: got %s want %s", got, fixture.ExpectedRevision)
	}
}
