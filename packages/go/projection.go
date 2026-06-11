package cnos

import (
	"encoding/json"
	"fmt"
)

const (
	ProjectionEnvVar    = "__CNOS_PROJECTION__"
	SecretPayloadEnvVar = "__CNOS_SECRET_PAYLOAD__"
	SessionKeyEnvVar    = "__CNOS_SESSION_KEY__"
)

type DerivedFormula struct {
	Expr        string   `json:"expr"`
	Deps        []string `json:"deps"`
	RuntimeRefs []string `json:"runtimeRefs"`
}

type SecretReference struct {
	Provider string `json:"provider"`
	Ref      string `json:"ref"`
	Vault    string `json:"vault,omitempty"`
	EnvVar   string `json:"envVar,omitempty"`
}

type ProjectionMeta struct {
	Workspace   string   `json:"workspace"`
	Profile     string   `json:"profile"`
	CnosVersion string   `json:"cnos_version"`
	Namespaces  []string `json:"namespaces,omitempty"`
}

type ServerProjection struct {
	Version           int                        `json:"version"`
	Workspace         string                     `json:"workspace"`
	Profile           string                     `json:"profile"`
	ResolvedAt        string                     `json:"resolvedAt"`
	ConfigHash        string                     `json:"configHash"`
	Values            map[string]any             `json:"values"`
	Derived           map[string]DerivedFormula  `json:"derived"`
	SecretRefs        map[string]SecretReference `json:"secretRefs"`
	Vaults            map[string]vaultDefinition `json:"vaults,omitempty"`
	PublicKeys        []string                   `json:"publicKeys"`
	RuntimeNamespaces []string                   `json:"runtimeNamespaces"`
	Meta              ProjectionMeta             `json:"meta"`
}

func ParseProjection(data []byte) (ServerProjection, error) {
	var projection ServerProjection
	if err := json.Unmarshal(data, &projection); err != nil {
		return ServerProjection{}, fmt.Errorf("cnos: parse server projection: %w", err)
	}

	if projection.Version != 1 ||
		projection.Workspace == "" ||
		projection.Profile == "" ||
		projection.ResolvedAt == "" ||
		projection.ConfigHash == "" ||
		projection.Values == nil ||
		projection.SecretRefs == nil ||
		projection.PublicKeys == nil ||
		projection.Meta.Workspace == "" ||
		projection.Meta.Profile == "" ||
		projection.Meta.CnosVersion == "" {
		return ServerProjection{}, fmt.Errorf("cnos: invalid server projection payload")
	}

	if projection.Derived == nil {
		projection.Derived = map[string]DerivedFormula{}
	}
	if projection.RuntimeNamespaces == nil {
		projection.RuntimeNamespaces = []string{}
	}
	if projection.Vaults == nil {
		projection.Vaults = map[string]vaultDefinition{}
	}
	if projection.Meta.Namespaces == nil {
		projection.Meta.Namespaces = []string{}
	}

	return projection, nil
}
