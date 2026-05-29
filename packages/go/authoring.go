package cnos

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	primaryCnosDir = ".cnos"
	legacyCnosDir  = "cnos"
)

var (
	defaultProfileResolveFrom = []string{"cli.profile", "env.CNOS_PROFILE", "default"}
	defaultLoaderOrder        = []string{"filesystem-values", "filesystem-secrets", "dotenv", "process-env", "cli-args"}
	defaultFrameworks         = map[string]string{
		"next":    "NEXT_PUBLIC_",
		"vite":    "VITE_",
		"nuxt":    "NUXT_PUBLIC_",
		"webpack": "",
	}
	defaultNamespaceDefs = map[string]namespaceDefinition{
		"value":  {Kind: "data", Shareable: true},
		"secret": {Kind: "data", Sensitive: true},
		"meta":   {Kind: "system", Readonly: true},
		"process": {
			Kind:     "system",
			Readonly: true,
		},
		"public": {
			Kind:      "projection",
			Source:    "promote",
			Shareable: true,
			Readonly:  true,
		},
		"env": {
			Kind:      "projection",
			Source:    "envMapping",
			Shareable: true,
			Readonly:  true,
		},
	}
)

type anchorFile struct {
	Root      string `yaml:"root"`
	Workspace string `yaml:"workspace"`
}

type workspaceFile struct {
	Workspace  string `yaml:"workspace"`
	Profile    string `yaml:"profile"`
	GlobalRoot string `yaml:"globalRoot"`
}

type workspaceItemFile struct {
	Extends  any    `yaml:"extends"`
	GlobalID string `yaml:"globalId"`
}

type manifestNamespacesFile struct {
	Runtime map[string]runtimeNamespaceFile `yaml:"runtime"`
	Entries map[string]namespaceFile        `yaml:",inline"`
}

type namespaceFile struct {
	Kind      string `yaml:"kind"`
	Shareable *bool  `yaml:"shareable"`
	Sensitive *bool  `yaml:"sensitive"`
	Readonly  *bool  `yaml:"readonly"`
	Source    string `yaml:"source"`
}

type runtimeNamespaceFile struct {
	Description string `yaml:"description"`
	ServerOnly  *bool  `yaml:"server_only"`
}

type vaultAuthSourceFile struct {
	From []string `yaml:"from"`
}

type vaultAuthFile struct {
	Method     string               `yaml:"method"`
	Passphrase *vaultAuthSourceFile `yaml:"passphrase"`
	Token      *vaultAuthSourceFile `yaml:"token"`
	Config     map[string]any       `yaml:"config"`
}

type vaultDefinition struct {
	Provider string            `yaml:"provider"`
	Auth     vaultAuthFile     `yaml:"auth"`
	Mapping  map[string]string `yaml:"mapping"`
}

type manifestFile struct {
	Version int `yaml:"version"`
	Project struct {
		Name string `yaml:"name"`
	} `yaml:"project"`
	Workspaces struct {
		Default string `yaml:"default"`
		Global  struct {
			Enabled    bool   `yaml:"enabled"`
			Root       string `yaml:"root"`
			AllowWrite bool   `yaml:"allowWrite"`
		} `yaml:"global"`
		Items map[string]workspaceItemFile `yaml:"items"`
	} `yaml:"workspaces"`
	Profiles struct {
		Default     string   `yaml:"default"`
		ResolveFrom []string `yaml:"resolveFrom"`
	} `yaml:"profiles"`
	Plugins struct {
		Loaders []string `yaml:"loaders"`
	} `yaml:"plugins"`
	Sources    map[string]map[string]any `yaml:"sources"`
	Resolution struct {
		Precedence  []string `yaml:"precedence"`
		ArrayPolicy string   `yaml:"arrayPolicy"`
	} `yaml:"resolution"`
	EnvMapping struct {
		Convention string            `yaml:"convention"`
		Explicit   map[string]string `yaml:"explicit"`
	} `yaml:"envMapping"`
	Public struct {
		Promote    []string          `yaml:"promote"`
		Frameworks map[string]string `yaml:"frameworks"`
	} `yaml:"public"`
	Namespaces manifestNamespacesFile     `yaml:"namespaces"`
	Vaults     map[string]vaultDefinition `yaml:"vaults"`
	Schema     map[string]configSpecRule  `yaml:"schema"`
}

type profileDefinitionFile struct {
	Name     string `yaml:"name"`
	Extends  any    `yaml:"extends"`
	Activate struct {
		Values   []string `yaml:"values"`
		Secrets  []string `yaml:"secrets"`
		EnvFiles []string `yaml:"envFiles"`
	} `yaml:"activate"`
}

type configSpecRule struct {
	Type               string   `yaml:"type"`
	Required           bool     `yaml:"required"`
	Pattern            string   `yaml:"pattern"`
	Default            any      `yaml:"default"`
	Enum               []any    `yaml:"enum"`
	Summary            string   `yaml:"summary"`
	Description        string   `yaml:"description"`
	Examples           []any    `yaml:"examples"`
	UsedBy             []string `yaml:"usedBy"`
	Deprecated         bool     `yaml:"deprecated"`
	DeprecationMessage string   `yaml:"deprecationMessage"`
}

type namespaceDefinition struct {
	Kind      string
	Shareable bool
	Sensitive bool
	Readonly  bool
	Source    string
}

type runtimeNamespaceDefinition struct {
	Description string
	ServerOnly  bool
	BuiltIn     bool
}

type normalizedWorkspaceItem struct {
	Extends  []string
	GlobalID string
}

type authoringManifest struct {
	ManifestRoot      string
	ProjectName       string
	WorkspaceDefault  string
	GlobalEnabled     bool
	GlobalRoot        string
	WorkspaceItems    map[string]normalizedWorkspaceItem
	ProfileDefault    string
	ResolveFrom       []string
	Loaders           []string
	Sources           map[string]map[string]any
	Precedence        []string
	ArrayPolicy       string
	EnvMapping        envMappingConfig
	PublicPromote     []string
	Frameworks        map[string]string
	Namespaces        map[string]namespaceDefinition
	RuntimeNamespaces map[string]runtimeNamespaceDefinition
	Vaults            map[string]vaultDefinition
	Schema            map[string]configSpecRule
}

type envMappingConfig struct {
	Convention string
	Explicit   map[string]string
}

type workspaceRoot struct {
	WorkspaceID string
	Path        string
}

type workspaceContext struct {
	WorkspaceID     string
	WorkspaceSource string
	GlobalRoot      string
	WorkspaceChain  []string
	WorkspaceRoots  []workspaceRoot
}

type profileSelection struct {
	Profile string
	Source  string
}

type profileActivation struct {
	Values   []string
	Secrets  []string
	EnvFiles []string
}

type expandedProfileChain struct {
	Profiles   []string
	Activation profileActivation
}

type configEntry struct {
	Key         string
	Value       any
	Namespace   string
	SourceID    string
	PluginID    string
	WorkspaceID string
	Origin      *ConfigOrigin
}

type resolvedConfigEntry struct {
	Key        string
	Value      any
	Namespace  string
	Winner     configEntry
	Overridden []configEntry
}

func loadAuthoringRuntime(options Options, env environment, secretHome string) (*Runtime, error) {
	manifestRoot, consumerRoot, anchoredWorkspace, err := resolveAuthoringRoot(options)
	if err != nil {
		return nil, err
	}

	manifest, err := loadAuthoringManifest(manifestRoot)
	if err != nil {
		return nil, err
	}

	workspaceFileConfig, err := loadAuthoringWorkspaceFile(consumerRoot)
	if err != nil {
		return nil, err
	}

	workspace, err := resolveAuthoringWorkspace(manifest, manifestRoot, workspaceFileConfig, anchoredWorkspace, options, env)
	if err != nil {
		return nil, err
	}

	profile := resolveAuthoringProfile(manifest, workspaceFileConfig, options, env)
	profileChain, err := expandAuthoringProfileChain(profile.Profile, workspace)
	if err != nil {
		return nil, err
	}

	entries, err := collectAuthoringEntries(manifest, workspace, profileChain, env)
	if err != nil {
		return nil, err
	}

	resolved := resolveAuthoringEntries(manifest, entries)
	applyAuthoringSchema(manifest, resolved, workspace.WorkspaceID)

	runtime := &Runtime{
		manifest:          manifest,
		env:               env,
		secretHome:        secretHome,
		entries:           map[string]*runtimeEntry{},
		sources:           map[string]string{},
		runtimeNamespaces: map[string]struct{}{},
		runtimeProviders:  map[string]RuntimeProvider{},
		encryptedSecrets:  map[string]any{},
		hydratedSecrets:   map[string]any{},
		localVaultCache:   map[string]map[string]string{},
		logicalKeyToVault: map[string]string{},
		vaults:            manifest.Vaults,
		projection: ServerProjection{
			Version:    1,
			Workspace:  workspace.WorkspaceID,
			Profile:    profile.Profile,
			ResolvedAt: time.Now().UTC().Format(time.RFC3339),
			ConfigHash: "",
			Values:     map[string]any{},
			Derived:    map[string]DerivedFormula{},
			SecretRefs: map[string]SecretReference{},
			PublicKeys: []string{},
			Meta: ProjectionMeta{
				Workspace:   workspace.WorkspaceID,
				Profile:     profile.Profile,
				CnosVersion: "authoring-runtime",
			},
		},
	}

	for key, entry := range resolved {
		runtimeEntryValue, err := toRuntimeEntry(key, entry)
		if err != nil {
			return nil, err
		}
		runtime.entries[key] = runtimeEntryValue
		runtime.sources[key] = entry.Winner.SourceID
	}

	for _, key := range manifest.PublicPromote {
		if err := ensurePromotionAllowed(manifest, key); err != nil {
			return nil, err
		}
		if _, ok := resolved[key]; !ok {
			continue
		}
		publicKey := toAuthoringPublicKey(key)
		runtime.entries[publicKey] = &runtimeEntry{
			key:          publicKey,
			namespace:    "public",
			aliasTo:      key,
			promotedFrom: key,
			winner: runtimeProvenance{
				sourceID:    "public-promote",
				pluginID:    "core",
				workspaceID: workspace.WorkspaceID,
			},
		}
		runtime.sources[publicKey] = "public-promote"
	}

	addAuthoringMetaEntries(runtime, manifest, workspace, profile)
	runtime.initializeRuntimeProviders(sortedRuntimeNamespaces(manifest.RuntimeNamespaces))
	if err := runtime.prepareDerivedEntries(); err != nil {
		return nil, err
	}

	return runtime, nil
}

func resolveAuthoringRoot(options Options) (string, string, string, error) {
	if options.Root != "" {
		consumerRoot, err := resolveWorkingDir(options.WorkingDir)
		if err != nil {
			return "", "", "", err
		}
		resolvedRoot, err := resolveRootURI(options.Root, consumerRoot, options, newEnvironment(options.Environment))
		if err != nil {
			return "", "", "", err
		}

		rootPath, err := resolvePathFromWorkingDir(options.WorkingDir, options.Root)
		if err == nil && !resolvedRoot.Remote {
			base := filepath.Base(resolvedRoot.ManifestRoot)
			if base == primaryCnosDir || base == legacyCnosDir {
				consumerRoot = filepath.Dir(resolvedRoot.ManifestRoot)
			} else {
				consumerRoot = rootPath
			}
		}

		return resolvedRoot.ManifestRoot, consumerRoot, "", nil
	}

	anchorPath, err := findCnosrcPath(options.WorkingDir)
	if err != nil {
		return "", "", "", err
	}
	if anchorPath == "" {
		return "", "", "", ErrProjectionNotFound
	}

	source, err := os.ReadFile(anchorPath)
	if err != nil {
		return "", "", "", fmt.Errorf("cnos: read %s: %w", anchorPath, err)
	}

	var anchor anchorFile
	if err := decodeYAMLDocument(source, &anchor); err != nil {
		return "", "", "", err
	}
	if strings.TrimSpace(anchor.Root) == "" {
		return "", "", "", fmt.Errorf("cnos: .cnosrc.yml requires root")
	}

	consumerRoot := filepath.Dir(anchorPath)
	resolvedRoot, err := resolveRootURI(anchor.Root, consumerRoot, options, newEnvironment(options.Environment))
	if err != nil {
		return "", "", "", err
	}

	return resolvedRoot.ManifestRoot, consumerRoot, strings.TrimSpace(anchor.Workspace), nil
}

func findCnosrcPath(workingDir string) (string, error) {
	current, err := resolveWorkingDir(workingDir)
	if err != nil {
		return "", err
	}

	for depth := 0; depth <= 3; depth += 1 {
		candidate := filepath.Join(current, ".cnosrc.yml")
		if fileExists(candidate) {
			return candidate, nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}

	return "", nil
}

func resolveCnosRoot(root string) (string, error) {
	basePath, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}

	candidates := []string{
		filepath.Join(basePath, primaryCnosDir),
		filepath.Join(basePath, legacyCnosDir),
		basePath,
	}

	for _, candidate := range candidates {
		if fileExists(filepath.Join(candidate, "cnos.yml")) {
			return candidate, nil
		}
	}

	return "", fmt.Errorf("cnos: could not locate .cnos/cnos.yml or cnos/cnos.yml from root: %s", basePath)
}

func loadAuthoringManifest(manifestRoot string) (authoringManifest, error) {
	source, err := os.ReadFile(filepath.Join(manifestRoot, "cnos.yml"))
	if err != nil {
		return authoringManifest{}, fmt.Errorf("cnos: unable to read CNOS manifest: %w", err)
	}

	var raw manifestFile
	if err := decodeYAMLDocument(source, &raw); err != nil {
		return authoringManifest{}, err
	}

	version := raw.Version
	if version == 0 {
		version = 1
	}
	if version != 1 {
		return authoringManifest{}, fmt.Errorf("cnos: unsupported CNOS manifest version: %d", version)
	}

	projectName := strings.TrimSpace(raw.Project.Name)
	if projectName == "" {
		return authoringManifest{}, fmt.Errorf("cnos: manifest requires project.name")
	}

	namespaces, runtimeNamespaces, err := normalizeAuthoringNamespaces(raw.Namespaces)
	if err != nil {
		return authoringManifest{}, err
	}

	vaults, err := normalizeAuthoringVaults(raw.Vaults)
	if err != nil {
		return authoringManifest{}, err
	}

	schema := normalizeAuthoringSchema(raw.Schema)
	sources := map[string]map[string]any{}
	for key, value := range raw.Sources {
		sources[key] = normalizeConfigMap(value)
	}
	ensureSourceDefaults(sources)

	resolveFrom := normalizeResolveFrom(raw.Profiles.ResolveFrom)
	loaders := append([]string(nil), raw.Plugins.Loaders...)
	if len(loaders) == 0 {
		loaders = append([]string(nil), defaultLoaderOrder...)
	}
	precedence := append([]string(nil), raw.Resolution.Precedence...)
	if len(precedence) == 0 {
		precedence = append([]string(nil), defaultLoaderOrder...)
	}
	arrayPolicy := strings.TrimSpace(raw.Resolution.ArrayPolicy)
	if arrayPolicy == "" {
		arrayPolicy = "replace"
	}

	frameworks := map[string]string{}
	for key, value := range defaultFrameworks {
		frameworks[key] = value
	}
	for key, value := range raw.Public.Frameworks {
		frameworks[key] = value
	}

	return authoringManifest{
		ManifestRoot:      manifestRoot,
		ProjectName:       projectName,
		WorkspaceDefault:  strings.TrimSpace(raw.Workspaces.Default),
		GlobalEnabled:     raw.Workspaces.Global.Enabled,
		GlobalRoot:        strings.TrimSpace(raw.Workspaces.Global.Root),
		WorkspaceItems:    normalizeWorkspaceItems(raw.Workspaces.Items),
		ProfileDefault:    firstNonEmpty(strings.TrimSpace(raw.Profiles.Default), "base"),
		ResolveFrom:       resolveFrom,
		Loaders:           loaders,
		Sources:           sources,
		Precedence:        precedence,
		ArrayPolicy:       arrayPolicy,
		EnvMapping:        envMappingConfig{Convention: raw.EnvMapping.Convention, Explicit: normalizeStringMap(raw.EnvMapping.Explicit)},
		PublicPromote:     trimStringSlice(raw.Public.Promote),
		Frameworks:        frameworks,
		Namespaces:        namespaces,
		RuntimeNamespaces: runtimeNamespaces,
		Vaults:            vaults,
		Schema:            schema,
	}, nil
}

func normalizeAuthoringNamespaces(raw manifestNamespacesFile) (map[string]namespaceDefinition, map[string]runtimeNamespaceDefinition, error) {
	namespaces := map[string]namespaceDefinition{}
	for key, value := range defaultNamespaceDefs {
		namespaces[key] = value
	}

	for namespace, definition := range raw.Entries {
		if namespace == "runtime" {
			continue
		}
		normalized := namespaceDefinition{
			Kind:      firstNonEmpty(strings.TrimSpace(definition.Kind), "data"),
			Shareable: definition.Shareable != nil && *definition.Shareable,
			Sensitive: definition.Sensitive != nil && *definition.Sensitive,
			Readonly:  definition.Readonly != nil && *definition.Readonly,
			Source:    strings.TrimSpace(definition.Source),
		}
		namespaces[namespace] = normalized
	}

	runtimeNamespaces := map[string]runtimeNamespaceDefinition{
		"process": {
			Description: "Live process runtime values.",
			ServerOnly:  true,
			BuiltIn:     true,
		},
	}

	for namespace, definition := range raw.Runtime {
		if _, reserved := defaultNamespaceDefs[namespace]; reserved || namespace == "runtime" {
			return nil, nil, fmt.Errorf("cnos: runtime namespace %q conflicts with a built-in or reserved namespace", namespace)
		}
		serverOnly := true
		if definition.ServerOnly != nil {
			serverOnly = *definition.ServerOnly
		}
		runtimeNamespaces[namespace] = runtimeNamespaceDefinition{
			Description: strings.TrimSpace(definition.Description),
			ServerOnly:  serverOnly,
		}
	}

	return namespaces, runtimeNamespaces, nil
}

func normalizeAuthoringVaults(raw map[string]vaultDefinition) (map[string]vaultDefinition, error) {
	vaults := map[string]vaultDefinition{}
	for name, definition := range raw {
		provider := strings.TrimSpace(definition.Provider)
		if provider == "" {
			return nil, fmt.Errorf("cnos: vault %q requires a provider", name)
		}
		vaults[name] = vaultDefinition{
			Provider: provider,
			Auth: vaultAuthFile{
				Method:     firstNonEmpty(strings.TrimSpace(definition.Auth.Method), defaultVaultMethod(provider)),
				Passphrase: normalizeVaultAuthSource(definition.Auth.Passphrase),
				Token:      normalizeVaultAuthSource(definition.Auth.Token),
				Config:     normalizeConfigMap(definition.Auth.Config),
			},
			Mapping: normalizeStringMap(definition.Mapping),
		}
	}
	return vaults, nil
}

func defaultVaultMethod(provider string) string {
	if provider == "local" {
		return "passphrase"
	}
	if provider == "github-secrets" || provider == "environment" {
		return "environment"
	}
	return ""
}

func normalizeVaultAuthSource(source *vaultAuthSourceFile) *vaultAuthSourceFile {
	if source == nil {
		return nil
	}
	return &vaultAuthSourceFile{From: trimStringSlice(source.From)}
}

func normalizeAuthoringSchema(raw map[string]configSpecRule) map[string]configSpecRule {
	schema := map[string]configSpecRule{}
	for key, rule := range raw {
		rule.Default = normalizeYAMLValue(rule.Default)
		rule.Enum = normalizeSlice(rule.Enum)
		rule.Examples = normalizeSlice(rule.Examples)
		rule.UsedBy = trimStringSlice(rule.UsedBy)
		schema[key] = rule
	}
	return schema
}

func ensureSourceDefaults(sources map[string]map[string]any) {
	if sources["filesystem-values"] == nil {
		sources["filesystem-values"] = map[string]any{}
	}
	if _, ok := sources["filesystem-values"]["root"]; !ok {
		sources["filesystem-values"]["root"] = "./"
	}
	if sources["filesystem-secrets"] == nil {
		sources["filesystem-secrets"] = map[string]any{}
	}
	if _, ok := sources["filesystem-secrets"]["root"]; !ok {
		sources["filesystem-secrets"]["root"] = "./"
	}
	if sources["dotenv"] == nil {
		sources["dotenv"] = map[string]any{}
	}
	if _, ok := sources["dotenv"]["root"]; !ok {
		sources["dotenv"]["root"] = "./env"
	}
}

func normalizeResolveFrom(values []string) []string {
	normalized := trimStringSlice(values)
	if len(normalized) == 0 {
		return append([]string(nil), defaultProfileResolveFrom...)
	}
	return normalized
}

func loadAuthoringWorkspaceFile(consumerRoot string) (*workspaceFile, error) {
	path := filepath.Join(consumerRoot, ".cnos-workspace.yml")
	source, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("cnos: read %s: %w", path, err)
	}

	var config workspaceFile
	if err := decodeYAMLDocument(source, &config); err != nil {
		return nil, err
	}
	config.Workspace = strings.TrimSpace(config.Workspace)
	config.Profile = strings.TrimSpace(config.Profile)
	config.GlobalRoot = strings.TrimSpace(config.GlobalRoot)
	return &config, nil
}

func resolveAuthoringWorkspace(
	manifest authoringManifest,
	manifestRoot string,
	workspaceFileConfig *workspaceFile,
	anchoredWorkspace string,
	options Options,
	env environment,
) (workspaceContext, error) {
	selectedWorkspace, source, err := selectWorkspace(manifest, workspaceFileConfig, anchoredWorkspace, options.Workspace)
	if err != nil {
		return workspaceContext{}, err
	}

	workspaceChain, err := expandAuthoringWorkspaceChain(selectedWorkspace, manifest.WorkspaceItems)
	if err != nil {
		return workspaceContext{}, err
	}

	globalRoot := ""
	if manifest.GlobalEnabled {
		if options.GlobalRoot != "" {
			globalRoot, err = expandHomePath(options.GlobalRoot)
			if err != nil {
				return workspaceContext{}, err
			}
		} else if workspaceFileConfig != nil && workspaceFileConfig.GlobalRoot != "" {
			globalRoot, err = expandHomePath(workspaceFileConfig.GlobalRoot)
			if err != nil {
				return workspaceContext{}, err
			}
		} else if manifest.GlobalRoot != "" {
			globalRoot, err = expandHomePath(manifest.GlobalRoot)
			if err != nil {
				return workspaceContext{}, err
			}
		} else if cnosHome, ok := env.Get("CNOS_HOME"); ok && cnosHome != "" {
			globalRoot, err = expandHomePath(cnosHome)
			if err != nil {
				return workspaceContext{}, err
			}
		}
	}

	workspaceRoots := make([]workspaceRoot, 0)
	if globalRoot != "" {
		for _, workspaceID := range workspaceChain {
			globalWorkspaceID := workspaceID
			if item, ok := manifest.WorkspaceItems[workspaceID]; ok && item.GlobalID != "" {
				globalWorkspaceID = item.GlobalID
			}
			workspaceRoots = append(workspaceRoots, workspaceRoot{
				WorkspaceID: workspaceID,
				Path:        filepath.Join(globalRoot, "workspaces", globalWorkspaceID),
			})
		}
	}

	for _, workspaceID := range workspaceChain {
		workspaceRootPath, err := resolveLocalWorkspaceRoot(manifestRoot, workspaceID, manifest)
		if err != nil {
			return workspaceContext{}, err
		}
		workspaceRoots = append(workspaceRoots, workspaceRoot{
			WorkspaceID: workspaceID,
			Path:        workspaceRootPath,
		})
	}

	return workspaceContext{
		WorkspaceID:     selectedWorkspace,
		WorkspaceSource: source,
		GlobalRoot:      globalRoot,
		WorkspaceChain:  workspaceChain,
		WorkspaceRoots:  workspaceRoots,
	}, nil
}

func selectWorkspace(
	manifest authoringManifest,
	workspaceFileConfig *workspaceFile,
	anchoredWorkspace string,
	optionWorkspace string,
) (string, string, error) {
	if strings.TrimSpace(optionWorkspace) != "" {
		return strings.TrimSpace(optionWorkspace), "cli", nil
	}
	if workspaceFileConfig != nil && workspaceFileConfig.Workspace != "" {
		return workspaceFileConfig.Workspace, "workspace-file", nil
	}
	if strings.TrimSpace(anchoredWorkspace) != "" {
		return strings.TrimSpace(anchoredWorkspace), "anchor-file", nil
	}
	if manifest.WorkspaceDefault != "" {
		return manifest.WorkspaceDefault, "manifest-default", nil
	}
	if len(manifest.WorkspaceItems) == 0 {
		return "default", "implicit", nil
	}
	return "", "", fmt.Errorf("cnos: workspace selection requires --workspace, .cnos-workspace.yml, or workspaces.default when workspaces.items are defined")
}

func resolveLocalWorkspaceRoot(manifestRoot, workspaceID string, manifest authoringManifest) (string, error) {
	workspaceRoot := filepath.Join(manifestRoot, "workspaces", workspaceID)
	if info, err := os.Stat(workspaceRoot); err == nil && info.IsDir() {
		return workspaceRoot, nil
	}

	customDataNamespaces := make([]string, 0)
	for namespace, definition := range manifest.Namespaces {
		if namespace == "value" || namespace == "secret" || definition.Kind != "data" || definition.Sensitive {
			continue
		}
		customDataNamespaces = append(customDataNamespaces, namespace)
	}
	legacyMarkers := []string{"values", "secrets", "env", "profiles"}
	legacyMarkers = append(legacyMarkers, customDataNamespaces...)
	for _, marker := range legacyMarkers {
		if info, err := os.Stat(filepath.Join(manifestRoot, marker)); err == nil && info.IsDir() {
			return manifestRoot, nil
		}
	}

	return workspaceRoot, nil
}

func expandAuthoringWorkspaceChain(workspaceID string, items map[string]normalizedWorkspaceItem) ([]string, error) {
	if len(items) == 0 {
		return []string{workspaceID}, nil
	}
	if _, ok := items[workspaceID]; !ok {
		return nil, fmt.Errorf("cnos: unknown workspace %q", workspaceID)
	}

	resolved := map[string]bool{}
	visiting := map[string]bool{}
	chain := make([]string, 0)

	var visit func(string) error
	visit = func(current string) error {
		if resolved[current] {
			return nil
		}
		if visiting[current] {
			return fmt.Errorf("cnos: detected workspace inheritance cycle involving %q", current)
		}

		item, ok := items[current]
		if !ok {
			return fmt.Errorf("cnos: unknown workspace %q", current)
		}

		visiting[current] = true
		for _, parent := range item.Extends {
			if err := visit(parent); err != nil {
				return err
			}
		}
		delete(visiting, current)
		resolved[current] = true
		chain = append(chain, current)
		return nil
	}

	if err := visit(workspaceID); err != nil {
		return nil, err
	}
	return chain, nil
}

func resolveAuthoringProfile(manifest authoringManifest, workspaceFileConfig *workspaceFile, options Options, env environment) profileSelection {
	for _, source := range manifest.ResolveFrom {
		switch source {
		case "cli.profile":
			if strings.TrimSpace(options.Profile) != "" {
				return profileSelection{Profile: strings.TrimSpace(options.Profile), Source: "cli"}
			}
		case "env.CNOS_PROFILE":
			if workspaceFileConfig != nil && workspaceFileConfig.Profile != "" {
				return profileSelection{Profile: workspaceFileConfig.Profile, Source: "workspace-file"}
			}
			if value, ok := env.Get("CNOS_PROFILE"); ok && value != "" {
				return profileSelection{Profile: value, Source: "env"}
			}
		case "default":
			return profileSelection{Profile: manifest.ProfileDefault, Source: "manifest-default"}
		}
	}

	return profileSelection{Profile: manifest.ProfileDefault, Source: "manifest-default"}
}

func expandAuthoringProfileChain(activeProfile string, workspace workspaceContext) (expandedProfileChain, error) {
	resolved := map[string]bool{}
	visiting := map[string]bool{}
	orderedProfiles := make([]string, 0)
	definitions := map[string]profileDefinitionFile{}

	var visit func(string) error
	visit = func(profileName string) error {
		if resolved[profileName] {
			return nil
		}
		if visiting[profileName] {
			return fmt.Errorf("cnos: detected profile inheritance cycle involving %q", profileName)
		}

		visiting[profileName] = true
		definition, err := loadProfileDefinition(profileName, workspace)
		if err != nil {
			return err
		}
		definitions[profileName] = definition
		for _, parent := range toStringSlice(definition.Extends) {
			if err := visit(parent); err != nil {
				return err
			}
		}
		delete(visiting, profileName)
		resolved[profileName] = true
		orderedProfiles = append(orderedProfiles, profileName)
		return nil
	}

	if err := visit(activeProfile); err != nil {
		return expandedProfileChain{}, err
	}

	activation := profileActivation{}
	for _, profileName := range orderedProfiles {
		definition := definitions[profileName]
		activation.Values = appendUnique(activation.Values, normalizeActivationLayers(definition.Activate.Values, "values")...)
		activation.Secrets = appendUnique(activation.Secrets, normalizeActivationLayers(definition.Activate.Secrets, "secrets")...)
		activation.EnvFiles = appendUnique(activation.EnvFiles, trimStringSlice(definition.Activate.EnvFiles)...)
	}

	fallback := buildFallbackActivation(activeProfile, orderedProfiles)
	if len(activation.Values) == 0 {
		activation.Values = fallback.Values
	}
	if len(activation.Secrets) == 0 {
		activation.Secrets = fallback.Secrets
	}
	if len(activation.EnvFiles) == 0 {
		activation.EnvFiles = fallback.EnvFiles
	}

	return expandedProfileChain{
		Profiles:   orderedProfiles,
		Activation: activation,
	}, nil
}

func loadProfileDefinition(profileName string, workspace workspaceContext) (profileDefinitionFile, error) {
	for index := len(workspace.WorkspaceRoots) - 1; index >= 0; index -= 1 {
		root := workspace.WorkspaceRoots[index]
		profilePath := filepath.Join(root.Path, "profiles", profileName+".yml")
		if !fileExists(profilePath) {
			continue
		}

		source, err := os.ReadFile(profilePath)
		if err != nil {
			return profileDefinitionFile{}, fmt.Errorf("cnos: read %s: %w", profilePath, err)
		}

		var definition profileDefinitionFile
		if err := decodeYAMLDocument(source, &definition); err != nil {
			return profileDefinitionFile{}, err
		}

		if definition.Name != "" && strings.TrimSpace(definition.Name) != profileName {
			return profileDefinitionFile{}, fmt.Errorf("cnos: profile file name mismatch: expected %q but found %q", profileName, definition.Name)
		}
		definition.Name = profileName
		return definition, nil
	}

	return profileDefinitionFile{Name: profileName}, nil
}

func buildFallbackActivation(activeProfile string, orderedProfiles []string) profileActivation {
	overlayProfiles := make([]string, 0)
	for _, profile := range orderedProfiles {
		if profile != "base" {
			overlayProfiles = append(overlayProfiles, profile)
		}
	}

	activation := profileActivation{
		Values: []string{"values"},
	}
	if activeProfile != "base" {
		activation.Values = append(activation.Values, "values/base")
	}
	for _, profile := range overlayProfiles {
		activation.Values = append(activation.Values, "profiles/"+profile+"/values", "values/"+profile)
		activation.Secrets = append(activation.Secrets, "profiles/"+profile+"/secrets", "secrets/"+profile)
	}
	if activeProfile == "base" {
		activation.EnvFiles = []string{".env"}
	} else {
		activation.EnvFiles = []string{".env", ".env." + activeProfile}
	}
	return activation
}

func collectAuthoringEntries(
	manifest authoringManifest,
	workspace workspaceContext,
	profiles expandedProfileChain,
	env environment,
) ([]configEntry, error) {
	entries := make([]configEntry, 0)
	for _, loader := range manifest.Loaders {
		switch loader {
		case "filesystem-values":
			loaded, err := loadFilesystemValueEntries(manifest, workspace, profiles)
			if err != nil {
				return nil, err
			}
			entries = append(entries, loaded...)
		case "filesystem-secrets":
			loaded, err := loadFilesystemSecretEntries(manifest, workspace, profiles)
			if err != nil {
				return nil, err
			}
			entries = append(entries, loaded...)
		case "dotenv":
			loaded, err := loadDotenvEntries(manifest, workspace, profiles)
			if err != nil {
				return nil, err
			}
			entries = append(entries, loaded...)
		case "process-env":
			entries = append(entries, loadProcessEnvEntries(manifest, workspace, env)...)
		case "cli-args":
			continue
		default:
			return nil, fmt.Errorf("cnos: unsupported loader plugin in Go runtime: %s", loader)
		}
	}
	return entries, nil
}

func loadFilesystemValueEntries(manifest authoringManifest, workspace workspaceContext, profiles expandedProfileChain) ([]configEntry, error) {
	sourceRoot := stringConfigValue(manifest.Sources["filesystem-values"], "root", "./")
	files, err := collectFilesystemLayerFiles(manifest.ManifestRoot, workspace.WorkspaceRoots, sourceRoot, profiles.Activation.Values)
	if err != nil {
		return nil, err
	}

	entries := make([]configEntry, 0)
	for _, file := range files {
		source, err := os.ReadFile(file.AbsolutePath)
		if err != nil {
			return nil, fmt.Errorf("cnos: read %s: %w", file.AbsolutePath, err)
		}
		loaded, err := yamlObjectToEntries(source, "value", "filesystem-values", file.WorkspaceID, file.AbsolutePath)
		if err != nil {
			return nil, err
		}
		entries = append(entries, loaded...)
	}

	customNamespaces := make([]string, 0)
	for namespace, definition := range manifest.Namespaces {
		if namespace == "value" || namespace == "secret" || definition.Kind != "data" || definition.Sensitive {
			continue
		}
		customNamespaces = append(customNamespaces, namespace)
	}
	sort.Strings(customNamespaces)

	for _, namespace := range customNamespaces {
		layers := []string{namespace}
		for _, profile := range profiles.Profiles {
			if profile == "base" {
				continue
			}
			layers = append(layers, "profiles/"+profile+"/"+namespace)
		}
		namespaceFiles, err := collectFilesystemLayerFiles(manifest.ManifestRoot, workspace.WorkspaceRoots, sourceRoot, layers)
		if err != nil {
			return nil, err
		}
		for _, file := range namespaceFiles {
			source, err := os.ReadFile(file.AbsolutePath)
			if err != nil {
				return nil, fmt.Errorf("cnos: read %s: %w", file.AbsolutePath, err)
			}
			loaded, err := yamlObjectToEntries(source, namespace, "filesystem-values", file.WorkspaceID, file.AbsolutePath)
			if err != nil {
				return nil, err
			}
			entries = append(entries, loaded...)
		}
	}

	return entries, nil
}

func loadFilesystemSecretEntries(manifest authoringManifest, workspace workspaceContext, profiles expandedProfileChain) ([]configEntry, error) {
	sourceRoot := stringConfigValue(manifest.Sources["filesystem-secrets"], "root", "./")
	files, err := collectFilesystemLayerFiles(manifest.ManifestRoot, workspace.WorkspaceRoots, sourceRoot, profiles.Activation.Secrets)
	if err != nil {
		return nil, err
	}

	entries := make([]configEntry, 0)
	for _, file := range files {
		source, err := os.ReadFile(file.AbsolutePath)
		if err != nil {
			return nil, fmt.Errorf("cnos: read %s: %w", file.AbsolutePath, err)
		}
		loaded, err := yamlObjectToEntries(source, "secret", "filesystem-secrets", file.WorkspaceID, file.AbsolutePath)
		if err != nil {
			return nil, err
		}
		entries = append(entries, loaded...)
	}
	return entries, nil
}

func loadDotenvEntries(manifest authoringManifest, workspace workspaceContext, profiles expandedProfileChain) ([]configEntry, error) {
	rootTemplate := stringConfigValue(manifest.Sources["dotenv"], "root", "./env")
	entries := make([]configEntry, 0)

	for _, workspaceRoot := range workspace.WorkspaceRoots {
		envRoot := resolveWorkspaceScopedPath(workspaceRoot.Path, rootTemplate, map[string]string{
			"workspace": workspaceRoot.WorkspaceID,
		})

		for _, fileName := range profiles.Activation.EnvFiles {
			absolutePath := filepath.Join(envRoot, fileName)
			if !fileExists(absolutePath) {
				continue
			}
			source, err := os.ReadFile(absolutePath)
			if err != nil {
				return nil, fmt.Errorf("cnos: read %s: %w", absolutePath, err)
			}
			parsed := parseDotenvDocument(string(source))
			for envVar, value := range parsed {
				logicalKey := envVarToLogicalKey(envVar, manifest.EnvMapping)
				if logicalKey == "" {
					continue
				}
				entries = append(entries, configEntry{
					Key:         logicalKey,
					Value:       value,
					Namespace:   namespaceForKey(logicalKey),
					SourceID:    "dotenv",
					PluginID:    "dotenv",
					WorkspaceID: workspaceRoot.WorkspaceID,
					Origin: &ConfigOrigin{
						File:   absolutePath,
						EnvVar: envVar,
					},
				})
			}
		}
	}

	return entries, nil
}

func loadProcessEnvEntries(manifest authoringManifest, workspace workspaceContext, env environment) []configEntry {
	if !env.useOS && len(env.override) == 0 {
		return nil
	}

	entries := make([]configEntry, 0)
	var envVars map[string]string
	if env.useOS {
		envVars = map[string]string{}
		for _, item := range os.Environ() {
			key, value, ok := strings.Cut(item, "=")
			if ok {
				envVars[key] = value
			}
		}
	} else {
		envVars = env.override
	}

	keys := make([]string, 0, len(envVars))
	for key := range envVars {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, envVar := range keys {
		logicalKey := envVarToLogicalKey(envVar, manifest.EnvMapping)
		if logicalKey == "" {
			continue
		}
		entries = append(entries, configEntry{
			Key:         logicalKey,
			Value:       envVars[envVar],
			Namespace:   namespaceForKey(logicalKey),
			SourceID:    "process-env",
			PluginID:    "process-env",
			WorkspaceID: workspace.WorkspaceID,
			Origin: &ConfigOrigin{
				EnvVar: envVar,
			},
		})
	}

	return entries
}

type loaderFile struct {
	AbsolutePath string
	WorkspaceID  string
}

func collectFilesystemLayerFiles(
	manifestRoot string,
	workspaceRoots []workspaceRoot,
	sourceRoot string,
	activeLayers []string,
) ([]loaderFile, error) {
	files := make([]loaderFile, 0)
	seen := map[string]bool{}
	for _, workspaceRoot := range workspaceRoots {
		resolvedRoot := filepath.Join(workspaceRoot.Path, sourceRoot)
		for _, layer := range activeLayers {
			layerRoot := filepath.Join(resolvedRoot, layer)
			collected, err := collectYAMLFiles(layerRoot)
			if err != nil {
				return nil, err
			}
			for _, file := range collected {
				if seen[file] {
					continue
				}
				seen[file] = true
				files = append(files, loaderFile{
					AbsolutePath: file,
					WorkspaceID:  workspaceRoot.WorkspaceID,
				})
			}
		}
	}
	return files, nil
}

func collectYAMLFiles(root string) ([]string, error) {
	info, err := os.Stat(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	if !info.IsDir() {
		return nil, nil
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	files := make([]string, 0)
	for _, entry := range entries {
		absolutePath := filepath.Join(root, entry.Name())
		if entry.IsDir() {
			nested, err := collectYAMLFiles(absolutePath)
			if err != nil {
				return nil, err
			}
			files = append(files, nested...)
			continue
		}
		extension := strings.ToLower(filepath.Ext(entry.Name()))
		if extension == ".yml" || extension == ".yaml" {
			files = append(files, absolutePath)
		}
	}
	sort.Strings(files)
	return files, nil
}

func yamlObjectToEntries(source []byte, namespace, sourceID, workspaceID, originFile string) ([]configEntry, error) {
	parsed, err := parseNormalizedYAMLDocument(source)
	if err != nil {
		return nil, err
	}

	document, ok := parsed.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("cnos: filesystem loader expected a YAML object document")
	}

	flattened := map[string]any{}
	flattenConfigObject(document, namespace == "secret", "", flattened)

	keys := make([]string, 0, len(flattened))
	for key := range flattened {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	entries := make([]configEntry, 0, len(keys))
	for _, key := range keys {
		var origin *ConfigOrigin
		if originFile != "" {
			origin = &ConfigOrigin{File: originFile}
		}
		entries = append(entries, configEntry{
			Key:         namespace + "." + key,
			Value:       flattened[key],
			Namespace:   namespace,
			SourceID:    sourceID,
			PluginID:    sourceID,
			WorkspaceID: workspaceID,
			Origin:      origin,
		})
	}
	return entries, nil
}

func flattenConfigObject(value map[string]any, stopAtSecretRef bool, prefix string, target map[string]any) {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	for _, key := range keys {
		nestedValue := value[key]
		nextKey := key
		if prefix != "" {
			nextKey = prefix + "." + key
		}

		document, ok := nestedValue.(map[string]any)
		if ok && !isDerivedValue(nestedValue) && !(stopAtSecretRef && isSecretReferenceValue(nestedValue)) {
			flattenConfigObject(document, stopAtSecretRef, nextKey, target)
			continue
		}

		target[nextKey] = nestedValue
	}
}

func resolveAuthoringEntries(manifest authoringManifest, entries []configEntry) map[string]*resolvedConfigEntry {
	precedence := map[string]int{}
	for index, sourceID := range manifest.Precedence {
		precedence[sourceID] = index
	}

	sortedEntries := append([]configEntry(nil), entries...)
	sort.SliceStable(sortedEntries, func(left, right int) bool {
		leftPrecedence, ok := precedence[sortedEntries[left].SourceID]
		if !ok {
			leftPrecedence = len(manifest.Precedence)
		}
		rightPrecedence, ok := precedence[sortedEntries[right].SourceID]
		if !ok {
			rightPrecedence = len(manifest.Precedence)
		}
		return leftPrecedence < rightPrecedence
	})

	resolved := map[string]*resolvedConfigEntry{}
	for _, entry := range sortedEntries {
		current, ok := resolved[entry.Key]
		if !ok {
			resolved[entry.Key] = &resolvedConfigEntry{
				Key:       entry.Key,
				Value:     entry.Value,
				Namespace: entry.Namespace,
				Winner:    entry,
			}
			continue
		}

		current.Overridden = append(current.Overridden, current.Winner)
		current.Value = mergeResolvedValue(current.Value, entry.Value, manifest.ArrayPolicy)
		current.Winner = entry
	}

	return resolved
}

func mergeResolvedValue(current, next any, arrayPolicy string) any {
	currentArray, currentIsArray := current.([]any)
	nextArray, nextIsArray := next.([]any)
	if currentIsArray && nextIsArray {
		switch arrayPolicy {
		case "append":
			return append(append([]any{}, currentArray...), nextArray...)
		case "unique-append":
			return uniqueAppend(currentArray, nextArray)
		default:
			return append([]any{}, nextArray...)
		}
	}

	currentMap, currentIsMap := current.(map[string]any)
	nextMap, nextIsMap := next.(map[string]any)
	if currentIsMap && nextIsMap {
		return deepMergeMaps(currentMap, nextMap, arrayPolicy)
	}

	return next
}

func deepMergeMaps(current, next map[string]any, arrayPolicy string) map[string]any {
	merged := map[string]any{}
	for key, value := range current {
		merged[key] = value
	}
	for key, value := range next {
		if existing, ok := merged[key]; ok {
			merged[key] = mergeResolvedValue(existing, value, arrayPolicy)
		} else {
			merged[key] = value
		}
	}
	return merged
}

func uniqueAppend(current, next []any) []any {
	values := append([]any{}, current...)
	seen := map[string]bool{}
	for _, value := range values {
		seen[stableJSON(value)] = true
	}
	for _, value := range next {
		serialized := stableJSON(value)
		if seen[serialized] {
			continue
		}
		seen[serialized] = true
		values = append(values, value)
	}
	return values
}

func applyAuthoringSchema(manifest authoringManifest, resolved map[string]*resolvedConfigEntry, workspaceID string) {
	keys := make([]string, 0, len(manifest.Schema))
	for key := range manifest.Schema {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	for _, key := range keys {
		rule := manifest.Schema[key]
		entry, ok := resolved[key]
		if !ok {
			if rule.Default != nil {
				resolved[key] = &resolvedConfigEntry{
					Key:       key,
					Value:     rule.Default,
					Namespace: namespaceForKey(key),
					Winner: configEntry{
						Key:         key,
						Value:       rule.Default,
						Namespace:   namespaceForKey(key),
						SourceID:    "schema-default",
						PluginID:    "schema-default",
						WorkspaceID: workspaceID,
					},
				}
			}
			continue
		}

		if isDerivedValue(entry.Value) {
			continue
		}
		entry.Value = coerceSchemaValue(entry.Value, rule)
	}
}

func coerceSchemaValue(value any, rule configSpecRule) any {
	if rule.Type == "" {
		return value
	}

	stringValue, ok := value.(string)
	if !ok {
		return value
	}

	switch rule.Type {
	case "number":
		if matched, _ := regexp.MatchString(`^-?\d+(\.\d+)?$`, stringValue); matched {
			var result float64
			fmt.Sscanf(stringValue, "%f", &result)
			return result
		}
	case "boolean":
		if stringValue == "true" {
			return true
		}
		if stringValue == "false" {
			return false
		}
	case "object", "array":
		var parsed any
		if err := json.Unmarshal([]byte(stringValue), &parsed); err == nil {
			parsed = normalizeYAMLValue(parsed)
			if rule.Type == "object" {
				if _, ok := parsed.(map[string]any); ok {
					return parsed
				}
			}
			if rule.Type == "array" {
				if _, ok := parsed.([]any); ok {
					return parsed
				}
			}
		}
	}

	return value
}

func toRuntimeEntry(key string, entry *resolvedConfigEntry) (*runtimeEntry, error) {
	runtimeEntryValue := &runtimeEntry{
		key:       key,
		namespace: entry.Namespace,
		winner: runtimeProvenance{
			sourceID:    entry.Winner.SourceID,
			pluginID:    entry.Winner.PluginID,
			workspaceID: entry.Winner.WorkspaceID,
			origin:      cloneOrigin(entry.Winner.Origin),
		},
	}
	for _, override := range entry.Overridden {
		runtimeEntryValue.overridden = append(runtimeEntryValue.overridden, runtimeProvenance{
			sourceID:    override.SourceID,
			pluginID:    override.PluginID,
			workspaceID: override.WorkspaceID,
			value:       override.Value,
			origin:      cloneOrigin(override.Origin),
		})
	}

	if entry.Namespace == "secret" && isSecretReferenceValue(entry.Value) {
		ref, err := toSecretReference(entry.Value)
		if err != nil {
			return nil, err
		}
		if ref.Vault == "" {
			ref.Vault = "default"
		}
		runtimeEntryValue.secretRef = &ref
		return runtimeEntryValue, nil
	}

	if isDerivedValue(entry.Value) {
		parsed, err := parseRawDerivedValue(entry.Value)
		if err != nil {
			return nil, fmt.Errorf("cnos: parse derived formula for %s: %w", key, err)
		}
		runtimeEntryValue.formula = &parsed
		return runtimeEntryValue, nil
	}

	runtimeEntryValue.value = entry.Value
	return runtimeEntryValue, nil
}

func addAuthoringMetaEntries(runtime *Runtime, manifest authoringManifest, workspace workspaceContext, profile profileSelection) {
	metaWinner := runtimeProvenance{
		sourceID:    "cnos-runtime",
		pluginID:    "cnos",
		workspaceID: workspace.WorkspaceID,
	}
	runtime.entries["meta.profile"] = &runtimeEntry{key: "meta.profile", namespace: "meta", value: profile.Profile, winner: metaWinner}
	runtime.entries["meta.workspace"] = &runtimeEntry{key: "meta.workspace", namespace: "meta", value: workspace.WorkspaceID, winner: metaWinner}
	runtime.entries["meta.cnos_version"] = &runtimeEntry{key: "meta.cnos_version", namespace: "meta", value: "authoring-runtime", winner: metaWinner}
	runtime.entries["meta.cnos.version"] = &runtimeEntry{key: "meta.cnos.version", namespace: "meta", value: "authoring-runtime", winner: metaWinner}
	runtime.entries["meta.resolved.from"] = &runtimeEntry{key: "meta.resolved.from", namespace: "meta", value: profile.Source, winner: metaWinner}
	runtime.entries["meta.global.enabled"] = &runtimeEntry{key: "meta.global.enabled", namespace: "meta", value: workspace.GlobalRoot != "", winner: metaWinner}
	runtime.entries["meta.globalRoot"] = &runtimeEntry{key: "meta.globalRoot", namespace: "meta", value: nil, winner: metaWinner}
	if workspace.GlobalRoot != "" {
		runtime.entries["meta.globalRoot"].value = workspace.GlobalRoot
	}
	runtime.entries["meta.workspace.chain"] = &runtimeEntry{key: "meta.workspace.chain", namespace: "meta", value: stringSliceToAnySlice(workspace.WorkspaceChain), winner: metaWinner}
	runtime.entries["meta.workspace.source"] = &runtimeEntry{key: "meta.workspace.source", namespace: "meta", value: workspace.WorkspaceSource, winner: metaWinner}
	runtime.projection.Workspace = workspace.WorkspaceID
	runtime.projection.Profile = profile.Profile
	runtime.projection.Meta.Workspace = workspace.WorkspaceID
	runtime.projection.Meta.Profile = profile.Profile
	runtime.projection.Meta.CnosVersion = "authoring-runtime"
	runtime.profileSource = profile.Source
	runtime.workspaceState = inspectWorkspaceState{
		ID:     workspace.WorkspaceID,
		Source: workspace.WorkspaceSource,
		Chain:  append([]string(nil), workspace.WorkspaceChain...),
	}
}

func ensurePromotionAllowed(manifest authoringManifest, key string) error {
	namespace := namespaceForKey(key)
	definition, ok := manifest.Namespaces[namespace]
	if !ok {
		definition = namespaceDefinition{Kind: "data"}
	}

	if definition.Kind != "data" {
		return fmt.Errorf("cnos: cannot promote %s to public because namespace %q is not a data namespace", key, namespace)
	}
	if definition.Sensitive {
		return fmt.Errorf("cnos: cannot promote %s to public because namespace %q is sensitive", key, namespace)
	}
	if !definition.Shareable {
		return fmt.Errorf("cnos: cannot promote %s to public because namespace %q is not shareable", key, namespace)
	}
	return nil
}

func toAuthoringPublicKey(key string) string {
	if strings.HasPrefix(key, "value.") {
		return "public." + strings.TrimPrefix(key, "value.")
	}
	return "public." + key
}

func resolveWorkspaceScopedPath(workspaceRoot, template string, tokens map[string]string) string {
	normalized := strings.ReplaceAll(template, "\\", "/")
	normalized = strings.TrimPrefix(normalized, "./")
	marker := "workspaces/{workspace}"
	switch {
	case normalized == marker:
		normalized = "."
	case strings.HasPrefix(normalized, marker+"/"):
		normalized = normalized[len(marker)+1:]
	}
	for token, value := range tokens {
		normalized = strings.ReplaceAll(normalized, "{"+token+"}", value)
	}
	return filepath.Join(workspaceRoot, normalized)
}

func envVarToLogicalKey(envVar string, config envMappingConfig) string {
	if explicit, ok := config.Explicit[envVar]; ok {
		return explicit
	}
	if config.Convention != "SCREAMING_SNAKE" {
		return ""
	}
	if strings.HasPrefix(envVar, "SECRET_") {
		stripped := strings.TrimPrefix(envVar, "SECRET_")
		if stripped == "" {
			return ""
		}
		return "secret." + fromScreamingSnake(stripped)
	}
	if !regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`).MatchString(envVar) {
		return ""
	}
	return "value." + fromScreamingSnake(envVar)
}

func fromScreamingSnake(value string) string {
	parts := make([]string, 0)
	for _, segment := range strings.Split(value, "_") {
		segment = strings.TrimSpace(segment)
		if segment != "" {
			parts = append(parts, strings.ToLower(segment))
		}
	}
	return strings.Join(parts, ".")
}

func parseDotenvDocument(document string) map[string]string {
	parsed := map[string]string{}
	lines := strings.Split(strings.ReplaceAll(document, "\r\n", "\n"), "\n")
	for _, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}
		name, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		envVar := strings.TrimSpace(name)
		resolved := strings.TrimSpace(value)
		if envVar == "" {
			continue
		}
		if len(resolved) >= 2 && ((resolved[0] == '"' && resolved[len(resolved)-1] == '"') || (resolved[0] == '\'' && resolved[len(resolved)-1] == '\'')) {
			resolved = resolved[1 : len(resolved)-1]
			if value[0] == '"' {
				resolved = strings.NewReplacer(`\n`, "\n", `\r`, "\r", `\t`, "\t", `\"`, `"`, `\\`, `\`).Replace(resolved)
			}
		} else if index := strings.Index(resolved, " #"); index >= 0 {
			resolved = strings.TrimSpace(resolved[:index])
		}
		parsed[envVar] = resolved
	}
	return parsed
}

func normalizeActivationLayers(values []string, namespace string) []string {
	normalized := make([]string, 0)
	for _, entry := range values {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if strings.Contains(entry, "/") || strings.Contains(entry, `\`) || strings.HasPrefix(entry, ".") {
			normalized = append(normalized, strings.ReplaceAll(entry, `\`, "/"))
			continue
		}
		normalized = append(normalized, namespace+"/"+entry)
	}
	return normalized
}

func normalizeWorkspaceItems(items map[string]workspaceItemFile) map[string]normalizedWorkspaceItem {
	normalized := map[string]normalizedWorkspaceItem{}
	for workspaceID, item := range items {
		normalized[workspaceID] = normalizedWorkspaceItem{
			Extends:  toStringSlice(item.Extends),
			GlobalID: strings.TrimSpace(item.GlobalID),
		}
	}
	return normalized
}

func toStringSlice(value any) []string {
	switch typed := value.(type) {
	case nil:
		return nil
	case string:
		if strings.TrimSpace(typed) == "" {
			return nil
		}
		return []string{strings.TrimSpace(typed)}
	case []any:
		values := make([]string, 0)
		for _, item := range typed {
			if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
				values = append(values, strings.TrimSpace(text))
			}
		}
		return values
	case []string:
		return trimStringSlice(typed)
	default:
		return nil
	}
}

func trimStringSlice(values []string) []string {
	trimmed := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			trimmed = append(trimmed, value)
		}
	}
	return trimmed
}

func appendUnique(target []string, values ...string) []string {
	seen := map[string]bool{}
	for _, value := range target {
		seen[value] = true
	}
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		target = append(target, value)
	}
	return target
}

func normalizeStringMap(values map[string]string) map[string]string {
	normalized := map[string]string{}
	for key, value := range values {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key != "" && value != "" {
			normalized[key] = value
		}
	}
	return normalized
}

func normalizeConfigMap(values map[string]any) map[string]any {
	normalized := map[string]any{}
	for key, value := range values {
		normalized[key] = normalizeYAMLValue(value)
	}
	return normalized
}

func normalizeSlice(values []any) []any {
	normalized := make([]any, len(values))
	for index, value := range values {
		normalized[index] = normalizeYAMLValue(value)
	}
	return normalized
}

func stringConfigValue(config map[string]any, key, fallback string) string {
	if config == nil {
		return fallback
	}
	value, ok := config[key]
	if !ok {
		return fallback
	}
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return fallback
	}
	return text
}

func toSecretReference(value any) (SecretReference, error) {
	document, ok := value.(map[string]any)
	if !ok {
		return SecretReference{}, fmt.Errorf("cnos: invalid secret reference")
	}

	provider, _ := document["provider"].(string)
	ref, _ := document["ref"].(string)
	vault, _ := document["vault"].(string)
	if strings.TrimSpace(provider) == "" || strings.TrimSpace(ref) == "" {
		return SecretReference{}, fmt.Errorf("cnos: invalid secret reference")
	}

	return SecretReference{
		Provider: strings.TrimSpace(provider),
		Ref:      strings.TrimSpace(ref),
		Vault:    strings.TrimSpace(vault),
	}, nil
}

func isSecretReferenceValue(value any) bool {
	document, ok := value.(map[string]any)
	if !ok {
		return false
	}
	provider, providerOK := document["provider"].(string)
	ref, refOK := document["ref"].(string)
	if !providerOK || !refOK || strings.TrimSpace(provider) == "" || strings.TrimSpace(ref) == "" {
		return false
	}
	for key := range document {
		if key != "provider" && key != "ref" && key != "vault" {
			return false
		}
	}
	return true
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func uniqueSortedStrings(values []string) []string {
	seen := map[string]bool{}
	unique := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		unique = append(unique, value)
	}
	sort.Strings(unique)
	return unique
}

func stableJSON(value any) string {
	bytes, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(bytes)
}

func sortedRuntimeNamespaces(values map[string]runtimeNamespaceDefinition) []string {
	namespaces := make([]string, 0, len(values))
	for namespace := range values {
		namespaces = append(namespaces, namespace)
	}
	sort.Strings(namespaces)
	return namespaces
}

func stringSliceToAnySlice(values []string) []any {
	items := make([]any, len(values))
	for index, value := range values {
		items[index] = value
	}
	return items
}
