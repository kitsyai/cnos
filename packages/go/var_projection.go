package cnos

import (
	"encoding/json"
	"time"
)

// VarSourceDef is a projected, read-only definition of a var source (transport
// endpoint) declared in the manifest under `varSources`. Adapters consume it at
// runtime; read sites never name a source directly.
type VarSourceDef struct {
	// Transport is one of "rpc", "http", "ws", "sse". The Go SDK implements
	// "http" (pull + latching receiver); other transports parse but are inert.
	Transport string `json:"transport"`
	// URL is the source base URL. HTTP pulls hit "{URL}/cnos/vars".
	URL string `json:"url"`
	// Auth maps an auth scheme (e.g. "bearer") to a secret.* reference resolved
	// via the existing Go secrets machinery.
	Auth map[string]string `json:"auth,omitempty"`
	// PollInterval is a duration string ("30s", "1m"); empty disables polling.
	PollInterval string `json:"pollInterval,omitempty"`
	// Verify is a secret.* reference used by the latching receiver to verify
	// inbound bearer tokens / HMAC signatures.
	Verify string `json:"verify,omitempty"`
}

// VarGroupDef maps a var group to its source and fetch policy.
type VarGroupDef struct {
	Source string `json:"source"`
	// Mode is "prefetch" (resolved during Ready) or "ondemand" (never blocks
	// Ready; first sync read serves fallback + triggers one background fetch).
	Mode string `json:"mode"`
	// TTL is the staleness window (duration string). Past TTL a snapshot reports
	// stale.
	TTL string `json:"ttl,omitempty"`
	// Lease is the fail-closed window (duration string). Past Lease a snapshot
	// reports expired.
	Lease string `json:"lease,omitempty"`
}

// DocumentSchema is a whole-document validation schema declared under
// `documents` and bound to a var key via a rule's Document field.
type DocumentSchema struct {
	Fields               map[string]DocumentField `json:"fields"`
	AdditionalProperties bool                     `json:"additionalProperties"`
}

// DocumentField declares one typed field within a document schema.
type DocumentField struct {
	Type     string `json:"type"`
	Required bool   `json:"required,omitempty"`
	Enum     []any  `json:"enum,omitempty"`
	Pattern  string `json:"pattern,omitempty"`
}

// VarKeyRule is the per-key schema rule for a var.<group>.<rest> key. It either
// binds a whole-document schema (Document) or declares a scalar/simple type with
// optional enum/pattern. Required makes the key mandatory (fail-fast). Default
// supplies the precedence tier-③ fallback value.
type VarKeyRule struct {
	Document   string `json:"document,omitempty"`
	Required   bool   `json:"required,omitempty"`
	Default    any    `json:"default,omitempty"`
	HasDefault bool   `json:"-"`
	Type       string `json:"type,omitempty"`
	Enum       []any  `json:"enum,omitempty"`
	Pattern    string `json:"pattern,omitempty"`
}

// UnmarshalJSON captures whether a "default" key was present (distinct from a
// default of false/null/0) so tier-③ fallback only fires when a default is
// actually declared.
func (rule *VarKeyRule) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if v, ok := raw["document"]; ok {
		_ = json.Unmarshal(v, &rule.Document)
	}
	if v, ok := raw["required"]; ok {
		_ = json.Unmarshal(v, &rule.Required)
	}
	if v, ok := raw["type"]; ok {
		_ = json.Unmarshal(v, &rule.Type)
	}
	if v, ok := raw["enum"]; ok {
		_ = json.Unmarshal(v, &rule.Enum)
	}
	if v, ok := raw["pattern"]; ok {
		_ = json.Unmarshal(v, &rule.Pattern)
	}
	if v, ok := raw["default"]; ok {
		rule.HasDefault = true
		_ = json.Unmarshal(v, &rule.Default)
	}
	return nil
}

// MarshalJSON emits "default" only when a default was actually declared, so the
// rule round-trips faithfully (a default of false/null is distinct from absent).
func (rule VarKeyRule) MarshalJSON() ([]byte, error) {
	out := map[string]any{}
	if rule.Document != "" {
		out["document"] = rule.Document
	}
	if rule.Required {
		out["required"] = true
	}
	if rule.Type != "" {
		out["type"] = rule.Type
	}
	if len(rule.Enum) > 0 {
		out["enum"] = rule.Enum
	}
	if rule.Pattern != "" {
		out["pattern"] = rule.Pattern
	}
	if rule.HasDefault {
		out["default"] = rule.Default
	}
	return json.Marshal(out)
}

// groupFromVarKey returns the group segment of a var key. It accepts either the
// full logical key ("var.agentic.lanes.vinci") or the prefix-stripped form
// ("agentic.lanes.vinci") and returns "agentic".
func groupFromVarKey(key string) string {
	rest := key
	if len(rest) > 4 && rest[:4] == "var." {
		rest = rest[4:]
	}
	for index := 0; index < len(rest); index++ {
		if rest[index] == '.' {
			return rest[:index]
		}
	}
	return rest
}

// parseVarDuration parses a manifest duration string ("30s", "10m"); empty or
// invalid yields 0 (feature disabled for that field).
func parseVarDuration(value string) time.Duration {
	if value == "" {
		return 0
	}
	if d, err := time.ParseDuration(value); err == nil {
		return d
	}
	return 0
}
