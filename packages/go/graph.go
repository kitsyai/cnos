package cnos

import (
	"encoding/json"
	"fmt"
	"sort"
)

const GraphEnvVar = "__CNOS_GRAPH__"

type RuntimeGraph struct {
	Entries       []GraphResolvedEntry    `json:"entries"`
	Profile       string                  `json:"profile"`
	ResolvedAt    string                  `json:"resolvedAt"`
	ProfileSource string                  `json:"profileSource"`
	Workspace     GraphWorkspace          `json:"workspace"`
	Overrides     map[string]OverrideSpec `json:"overrides,omitempty"`
}

type GraphResolvedEntry struct {
	Key        string             `json:"key"`
	Value      any                `json:"value"`
	Namespace  string             `json:"namespace"`
	Winner     GraphConfigEntry   `json:"winner"`
	Overridden []GraphConfigEntry `json:"overridden"`
}

type GraphConfigEntry struct {
	Key         string         `json:"key"`
	Value       any            `json:"value"`
	Namespace   string         `json:"namespace"`
	SourceID    string         `json:"sourceId"`
	PluginID    string         `json:"pluginId"`
	WorkspaceID string         `json:"workspaceId"`
	Profile     string         `json:"profile,omitempty"`
	Origin      *ConfigOrigin  `json:"origin,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

type GraphWorkspace struct {
	WorkspaceID      string               `json:"workspaceId"`
	WorkspaceSource  string               `json:"workspaceSource"`
	GlobalRoot       string               `json:"globalRoot,omitempty"`
	GlobalRootSource string               `json:"globalRootSource,omitempty"`
	WorkspaceChain   []string             `json:"workspaceChain"`
	WorkspaceRoots   []GraphWorkspaceRoot `json:"workspaceRoots"`
}

type GraphWorkspaceRoot struct {
	Scope       string `json:"scope"`
	WorkspaceID string `json:"workspaceId"`
	Path        string `json:"path"`
}

func ParseRuntimeGraph(data []byte) (RuntimeGraph, error) {
	var graph RuntimeGraph
	if err := json.Unmarshal(data, &graph); err != nil {
		return RuntimeGraph{}, fmt.Errorf("cnos: parse runtime graph: %w", err)
	}

	if graph.Profile == "" || graph.ResolvedAt == "" || graph.ProfileSource == "" || graph.Workspace.WorkspaceID == "" || graph.Workspace.WorkspaceSource == "" || graph.Workspace.WorkspaceChain == nil || graph.Entries == nil {
		return RuntimeGraph{}, fmt.Errorf("cnos: invalid runtime graph payload")
	}

	for index := range graph.Entries {
		entry := &graph.Entries[index]
		if entry.Key == "" || entry.Namespace == "" || entry.Winner.Key == "" || entry.Winner.Namespace == "" || entry.Winner.SourceID == "" || entry.Winner.PluginID == "" || entry.Winner.WorkspaceID == "" {
			return RuntimeGraph{}, fmt.Errorf("cnos: invalid runtime graph payload")
		}
		if entry.Overridden == nil {
			entry.Overridden = []GraphConfigEntry{}
		}
	}

	if graph.Workspace.WorkspaceRoots == nil {
		graph.Workspace.WorkspaceRoots = []GraphWorkspaceRoot{}
	}

	return graph, nil
}

func runtimeEntryFromGraph(resolved GraphResolvedEntry) (*runtimeEntry, error) {
	entry := &runtimeEntry{
		key:       resolved.Key,
		namespace: resolved.Namespace,
		winner: runtimeProvenance{
			sourceID:    resolved.Winner.SourceID,
			pluginID:    resolved.Winner.PluginID,
			workspaceID: resolved.Winner.WorkspaceID,
			origin:      cloneOrigin(resolved.Winner.Origin),
		},
	}

	if promotedFrom, _ := resolved.Winner.Metadata["promotedFrom"].(string); promotedFrom != "" {
		entry.promotedFrom = promotedFrom
	}

	for _, override := range resolved.Overridden {
		entry.overridden = append(entry.overridden, runtimeProvenance{
			sourceID:    override.SourceID,
			pluginID:    override.PluginID,
			workspaceID: override.WorkspaceID,
			value:       override.Value,
			origin:      cloneOrigin(override.Origin),
		})
	}

	if resolved.Namespace == "secret" && isSecretReferenceValue(resolved.Value) {
		ref, err := toSecretReference(resolved.Value)
		if err != nil {
			return nil, err
		}
		if ref.Vault == "" {
			ref.Vault = "default"
		}
		entry.secretRef = &ref
		return entry, nil
	}

	if isDerivedValue(resolved.Value) {
		parsed, err := parseRawDerivedValue(resolved.Value)
		if err != nil {
			return nil, fmt.Errorf("cnos: parse derived formula for %s: %w", resolved.Key, err)
		}
		entry.formula = &parsed
		return entry, nil
	}

	entry.value = resolved.Value
	return entry, nil
}

func bootstrappedManifestFromGraph(graph RuntimeGraph) authoringManifest {
	namespaces := map[string]namespaceDefinition{}
	for key, value := range defaultNamespaceDefs {
		namespaces[key] = value
	}

	runtimeNamespaces := map[string]runtimeNamespaceDefinition{
		"process": {
			Description: "Live process runtime values.",
			ServerOnly:  true,
			BuiltIn:     true,
		},
	}
	for _, namespace := range discoverRuntimeNamespacesFromGraph(graph) {
		if namespace == "process" {
			continue
		}
		runtimeNamespaces[namespace] = runtimeNamespaceDefinition{ServerOnly: true}
	}

	frameworks := map[string]string{}
	for key, value := range defaultFrameworks {
		frameworks[key] = value
	}

	return authoringManifest{
		ProjectName:       "bootstrapped",
		WorkspaceDefault:  graph.Workspace.WorkspaceID,
		ProfileDefault:    graph.Profile,
		ResolveFrom:       []string{"default"},
		EnvMapping:        envMappingConfig{Explicit: map[string]string{}},
		Frameworks:        frameworks,
		Namespaces:        namespaces,
		RuntimeNamespaces: runtimeNamespaces,
		Vaults:            map[string]vaultDefinition{},
	}
}

func bootstrappedDynamicManifest() authoringManifest {
	namespaces := map[string]namespaceDefinition{}
	for key, value := range defaultNamespaceDefs {
		namespaces[key] = value
	}
	frameworks := map[string]string{}
	for key, value := range defaultFrameworks {
		frameworks[key] = value
	}
	return authoringManifest{
		ProjectName:      "dynamic",
		WorkspaceDefault: "base",
		EnvMapping:       envMappingConfig{Explicit: map[string]string{}},
		Frameworks:       frameworks,
		Namespaces:       namespaces,
		RuntimeNamespaces: map[string]runtimeNamespaceDefinition{
			"process": {
				Description: "Live process runtime values.",
				ServerOnly:  true,
				BuiltIn:     true,
			},
		},
		Vaults: map[string]vaultDefinition{},
		Schema: map[string]configSpecRule{},
	}
}

func discoverRuntimeNamespacesFromGraph(graph RuntimeGraph) []string {
	configNamespaces := map[string]struct{}{
		"value":  {},
		"secret": {},
		"meta":   {},
		"public": {},
	}
	for _, entry := range graph.Entries {
		configNamespaces[entry.Namespace] = struct{}{}
	}

	runtimeNamespaces := map[string]struct{}{}
	for _, entry := range graph.Entries {
		if !isDerivedValue(entry.Value) {
			continue
		}

		parsed, err := parseRawDerivedValue(entry.Value)
		if err != nil {
			continue
		}

		for _, ref := range parsed.refs {
			namespace := namespaceForKey(ref)
			if namespace == "" {
				continue
			}
			if _, ok := configNamespaces[namespace]; ok {
				continue
			}
			runtimeNamespaces[namespace] = struct{}{}
		}
	}

	namespaces := make([]string, 0, len(runtimeNamespaces))
	for namespace := range runtimeNamespaces {
		namespaces = append(namespaces, namespace)
	}
	sort.Strings(namespaces)
	return namespaces
}
