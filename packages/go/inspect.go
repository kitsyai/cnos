package cnos

import (
	"fmt"
	"sort"
	"strings"
)

type ConfigOrigin struct {
	File   string `json:"file,omitempty"`
	Line   int    `json:"line,omitempty"`
	EnvVar string `json:"envVar,omitempty"`
	CliArg string `json:"cliArg,omitempty"`
}

type InspectResult struct {
	Key           string            `json:"key"`
	Value         any               `json:"value"`
	Namespace     string            `json:"namespace"`
	Profile       string            `json:"profile"`
	ProfileSource string            `json:"profileSource"`
	Workspace     InspectWorkspace  `json:"workspace"`
	Winner        InspectWinner     `json:"winner"`
	Overridden    []InspectOverride `json:"overridden"`
	Derived       *InspectDerived   `json:"derived,omitempty"`
}

type InspectWorkspace struct {
	ID     string   `json:"id"`
	Source string   `json:"source"`
	Chain  []string `json:"chain"`
}

type InspectWinner struct {
	SourceID    string        `json:"sourceId"`
	PluginID    string        `json:"pluginId"`
	WorkspaceID string        `json:"workspaceId"`
	Origin      *ConfigOrigin `json:"origin,omitempty"`
}

type InspectOverride struct {
	SourceID    string        `json:"sourceId"`
	PluginID    string        `json:"pluginId"`
	WorkspaceID string        `json:"workspaceId"`
	Value       any           `json:"value"`
	Origin      *ConfigOrigin `json:"origin,omitempty"`
}

type InspectDerived struct {
	Type              string              `json:"type"`
	Expression        string              `json:"expression"`
	Dependencies      []InspectDependency `json:"dependencies"`
	RuntimeDependent  bool                `json:"runtimeDependent"`
	RuntimeNamespaces []string            `json:"runtimeNamespaces"`
	PromotionWarning  string              `json:"promotionWarning,omitempty"`
}

type InspectDependency struct {
	Key              string `json:"key"`
	Value            any    `json:"value"`
	RuntimeNamespace string `json:"runtimeNamespace,omitempty"`
}

type inspectWorkspaceState struct {
	ID     string
	Source string
	Chain  []string
}

func (runtime *Runtime) Inspect(key string) (InspectResult, error) {
	entry := runtime.entries[key]
	if entry == nil {
		return InspectResult{}, fmt.Errorf("%w: %s", ErrMissingKey, key)
	}

	value, _, err := runtime.Read(key)
	if err != nil {
		return InspectResult{}, err
	}

	result := InspectResult{
		Key:           key,
		Value:         value,
		Namespace:     entry.namespace,
		Profile:       runtime.profileWorkspace("profile"),
		ProfileSource: firstNonEmpty(runtime.profileSource, "manifest-default"),
		Workspace: InspectWorkspace{
			ID:     firstNonEmpty(runtime.workspaceState.ID, runtime.profileWorkspace("workspace")),
			Source: firstNonEmpty(runtime.workspaceState.Source, "implicit"),
			Chain:  runtime.inspectWorkspaceChain(),
		},
		Winner: InspectWinner{
			SourceID:    firstNonEmpty(entry.winner.sourceID, runtime.sources[key]),
			PluginID:    firstNonEmpty(entry.winner.pluginID, "cnos"),
			WorkspaceID: firstNonEmpty(entry.winner.workspaceID, runtime.profileWorkspace("workspace")),
			Origin:      cloneOrigin(entry.winner.origin),
		},
		Overridden: make([]InspectOverride, 0, len(entry.overridden)),
	}

	for _, override := range entry.overridden {
		result.Overridden = append(result.Overridden, InspectOverride{
			SourceID:    override.sourceID,
			PluginID:    firstNonEmpty(override.pluginID, override.sourceID),
			WorkspaceID: override.workspaceID,
			Value:       override.value,
			Origin:      cloneOrigin(override.origin),
		})
	}

	if entry.formula != nil {
		derived, err := runtime.inspectDerived(key, entry)
		if err != nil {
			return InspectResult{}, err
		}
		result.Derived = derived
	}

	return result, nil
}

func (runtime *Runtime) inspectDerived(key string, entry *runtimeEntry) (*InspectDerived, error) {
	dependencies := make([]InspectDependency, 0, len(entry.formula.refs))
	for _, ref := range entry.formula.refs {
		value, ok, err := runtime.Read(ref)
		if err != nil {
			return nil, err
		}

		dependency := InspectDependency{Key: ref}
		if ok {
			dependency.Value = value
		}
		namespace := namespaceForKey(ref)
		if _, runtimeNamespace := runtime.runtimeNamespaces[namespace]; runtimeNamespace {
			dependency.RuntimeNamespace = namespace
		}
		dependencies = append(dependencies, dependency)
	}

	runtimeNamespaces := make([]string, 0, len(entry.formula.runtimeRefs))
	for _, ref := range entry.formula.runtimeRefs {
		namespace := namespaceForKey(ref)
		if namespace == "" {
			continue
		}
		runtimeNamespaces = append(runtimeNamespaces, namespace)
	}
	runtimeNamespaces = uniqueSortedStrings(runtimeNamespaces)
	sort.Strings(runtimeNamespaces)

	derived := &InspectDerived{
		Type:              formulaType(entry.formula),
		Expression:        entry.formula.raw,
		Dependencies:      dependencies,
		RuntimeDependent:  entry.formula.runtimeDependent,
		RuntimeNamespaces: runtimeNamespaces,
	}
	if entry.formula.runtimeDependent {
		derived.PromotionWarning = "Cannot be promoted to browser/public."
	}
	return derived, nil
}

func (runtime *Runtime) inspectWorkspaceChain() []string {
	if len(runtime.workspaceState.Chain) > 0 {
		return append([]string(nil), runtime.workspaceState.Chain...)
	}
	workspace := runtime.profileWorkspace("workspace")
	if workspace == "" {
		return nil
	}
	return []string{workspace}
}

func newImplicitWorkspaceState(workspace string) inspectWorkspaceState {
	if strings.TrimSpace(workspace) == "" {
		return inspectWorkspaceState{Source: "implicit"}
	}
	return inspectWorkspaceState{
		ID:     workspace,
		Source: "implicit",
		Chain:  []string{workspace},
	}
}

func formulaType(formula *parsedFormula) string {
	if formula == nil {
		return ""
	}
	if strings.Contains(formula.raw, "${") {
		return "template"
	}
	return "expression"
}

func cloneOrigin(origin *ConfigOrigin) *ConfigOrigin {
	if origin == nil {
		return nil
	}
	copy := *origin
	return &copy
}
