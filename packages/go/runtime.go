package cnos

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type RuntimeProvider func(path string) any

type Options struct {
	ProjectionPath       string
	ProjectionData       []byte
	Root                 string
	Workspace            string
	Profile              string
	GlobalRoot           string
	CacheMode            string
	CacheTTLSeconds      int
	ForceRefresh         bool
	WorkingDir           string
	Environment          map[string]string
	SecretHome           string
	SecretVaultProviders []SecretVaultProviderFactory
}

type Runtime struct {
	projection        ServerProjection
	manifest          authoringManifest
	profileSource     string
	workspaceState    inspectWorkspaceState
	graphBootstrapped bool
	env               environment
	secretHome        string
	entries           map[string]*runtimeEntry
	sources           map[string]string
	runtimeNamespaces map[string]struct{}
	runtimeProviders  map[string]RuntimeProvider
	encryptedSecrets  map[string]any
	hydratedSecrets   map[string]any
	localVaultCache   map[string]map[string]string
	logicalKeyToVault map[string]string
	vaults            map[string]vaultDefinition
	secretFactories   map[string]SecretVaultProviderFactory
}

type runtimeProvenance struct {
	sourceID    string
	pluginID    string
	workspaceID string
	value       any
	origin      *ConfigOrigin
}

type runtimeEntry struct {
	key           string
	namespace     string
	value         any
	aliasTo       string
	promotedFrom  string
	formula       *parsedFormula
	formulaCached bool
	formulaCache  any
	secretRef     *SecretReference
	winner        runtimeProvenance
	overridden    []runtimeProvenance
}

func Load(options Options) (*Runtime, error) {
	env := newEnvironment(options.Environment)
	secretHome, err := resolveSecretHome(env, options.SecretHome)
	if err != nil {
		return nil, fmt.Errorf("cnos: resolve secret home: %w", err)
	}

	switch {
	case len(options.ProjectionData) > 0:
		return newRuntime(options.ProjectionData, env, secretHome, options.SecretVaultProviders)
	case options.ProjectionPath != "":
		projectionPath, err := resolvePathFromWorkingDir(options.WorkingDir, options.ProjectionPath)
		if err != nil {
			return nil, fmt.Errorf("cnos: resolve projection path %s: %w", options.ProjectionPath, err)
		}
		bytes, err := os.ReadFile(projectionPath)
		if err != nil {
			return nil, fmt.Errorf("cnos: read projection file %s: %w", projectionPath, err)
		}
		return newRuntime(bytes, env, secretHome, options.SecretVaultProviders)
	}

	if serialized, ok := env.Get(GraphEnvVar); ok && serialized != "" {
		return newRuntimeFromGraph([]byte(serialized), env, secretHome, options.SecretVaultProviders)
	}

	if serialized, ok := env.Get(ProjectionEnvVar); ok && serialized != "" {
		return newRuntime([]byte(serialized), env, secretHome, options.SecretVaultProviders)
	}

	projectionPath, err := findProjectionPath(options.WorkingDir)
	if err != nil {
		return nil, fmt.Errorf("cnos: discover projection file: %w", err)
	}
	if projectionPath != "" {
		bytes, err := os.ReadFile(projectionPath)
		if err != nil {
			return nil, fmt.Errorf("cnos: read projection file %s: %w", projectionPath, err)
		}
		return newRuntime(bytes, env, secretHome, options.SecretVaultProviders)
	}

	return loadAuthoringRuntime(options, env, secretHome)
}

func LoadProjection(data []byte, options Options) (*Runtime, error) {
	options.ProjectionData = data
	return Load(options)
}

func LoadProjectionFile(path string, options Options) (*Runtime, error) {
	options.ProjectionPath = path
	return Load(options)
}

func (runtime *Runtime) Projection() ServerProjection {
	return runtime.projection
}

func (runtime *Runtime) Read(key string) (any, bool, error) {
	return runtime.readInternal(key, map[string]bool{})
}

func (runtime *Runtime) Require(key string) (any, error) {
	value, ok, err := runtime.Read(key)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrMissingKey, key)
	}
	return value, nil
}

func (runtime *Runtime) Value(path string) (any, bool, error) {
	return runtime.Read(toLogicalKey("value", path))
}

func (runtime *Runtime) Secret(path string) (any, bool, error) {
	return runtime.Read(toLogicalKey("secret", path))
}

func (runtime *Runtime) Meta(path string) (any, bool, error) {
	return runtime.Read(toLogicalKey("meta", path))
}

func (runtime *Runtime) Public(path string) (any, bool, error) {
	return runtime.Read(toLogicalKey("public", path))
}

func (runtime *Runtime) RegisterRuntimeProvider(namespace string, provider RuntimeProvider) error {
	if namespace == "process" {
		return fmt.Errorf("cnos: cannot override built-in runtime namespace %q", namespace)
	}
	if _, ok := runtime.runtimeNamespaces[namespace]; !ok {
		return fmt.Errorf("cnos: cannot register runtime provider for undeclared namespace %q", namespace)
	}

	runtime.runtimeProviders[namespace] = provider
	return nil
}

// RegisterSecretVaultProviders adds remote secret vault provider factories to this runtime.
func (runtime *Runtime) RegisterSecretVaultProviders(factories ...SecretVaultProviderFactory) {
	if runtime.secretFactories == nil {
		runtime.secretFactories = map[string]SecretVaultProviderFactory{}
	}
	for provider, factory := range secretVaultFactoryMap(factories) {
		runtime.secretFactories[provider] = factory
	}
}

func (runtime *Runtime) RefreshSecrets() error {
	refreshed := runtime.withSecretCaches(map[string]any{}, map[string]map[string]string{})
	if err := refreshed.warmSecrets(); err != nil {
		return err
	}
	runtime.hydratedSecrets = refreshed.hydratedSecrets
	runtime.localVaultCache = refreshed.localVaultCache
	return nil
}

func (runtime *Runtime) RefreshSecret(path string) error {
	key := toLogicalKey("secret", path)
	entry := runtime.entries[key]
	if entry == nil || entry.secretRef == nil {
		return nil
	}

	hydratedSecrets := cloneAnyMap(runtime.hydratedSecrets)
	delete(hydratedSecrets, key)
	localVaultCache := cloneLocalVaultCache(runtime.localVaultCache)
	if vault, ok := runtime.logicalKeyToVault[key]; ok {
		delete(localVaultCache, vault)
	}

	refreshed := runtime.withSecretCaches(hydratedSecrets, localVaultCache)
	if _, _, err := refreshed.readSecret(key, *entry.secretRef); err != nil {
		return err
	}

	delete(runtime.hydratedSecrets, key)
	if value, ok := refreshed.hydratedSecrets[key]; ok {
		runtime.hydratedSecrets[key] = value
	}
	if vault, ok := runtime.logicalKeyToVault[key]; ok {
		if cache, found := refreshed.localVaultCache[vault]; found {
			runtime.localVaultCache[vault] = cache
		} else {
			delete(runtime.localVaultCache, vault)
		}
	}
	return nil
}

func (runtime *Runtime) withSecretCaches(hydratedSecrets map[string]any, localVaultCache map[string]map[string]string) *Runtime {
	copy := *runtime
	copy.hydratedSecrets = hydratedSecrets
	copy.localVaultCache = localVaultCache
	return &copy
}

func newRuntime(source []byte, env environment, secretHome string, factories []SecretVaultProviderFactory) (*Runtime, error) {
	projection, err := ParseProjection(source)
	if err != nil {
		return nil, err
	}

	encryptedSecrets, err := decryptSecretPayloadFromEnv(env)
	if err != nil {
		return nil, err
	}

	manifest := bootstrappedManifestFromProjection(projection)
	runtime := &Runtime{
		projection:        projection,
		manifest:          manifest,
		profileSource:     "manifest-default",
		workspaceState:    newImplicitWorkspaceState(projection.Workspace),
		env:               env,
		secretHome:        secretHome,
		entries:           map[string]*runtimeEntry{},
		sources:           map[string]string{},
		runtimeNamespaces: map[string]struct{}{},
		runtimeProviders:  map[string]RuntimeProvider{},
		encryptedSecrets:  encryptedSecrets,
		hydratedSecrets:   map[string]any{},
		localVaultCache:   map[string]map[string]string{},
		logicalKeyToVault: map[string]string{},
		vaults:            manifest.Vaults,
		secretFactories:   secretVaultFactoryMap(factories),
	}

	if err := runtime.populateEntries(); err != nil {
		return nil, err
	}
	runtime.initializeRuntimeProviders(projection.RuntimeNamespaces)
	if err := runtime.prepareDerivedEntries(); err != nil {
		return nil, err
	}
	return runtime, nil
}

func newRuntimeFromGraph(source []byte, env environment, secretHome string, factories []SecretVaultProviderFactory) (*Runtime, error) {
	graph, err := ParseRuntimeGraph(source)
	if err != nil {
		return nil, err
	}

	encryptedSecrets, err := decryptSecretPayloadFromEnv(env)
	if err != nil {
		return nil, err
	}

	manifest := bootstrappedManifestFromGraph(graph)
	runtime := &Runtime{
		manifest:          manifest,
		profileSource:     graph.ProfileSource,
		workspaceState:    inspectWorkspaceState{ID: graph.Workspace.WorkspaceID, Source: graph.Workspace.WorkspaceSource, Chain: append([]string(nil), graph.Workspace.WorkspaceChain...)},
		graphBootstrapped: true,
		env:               env,
		secretHome:        secretHome,
		entries:           map[string]*runtimeEntry{},
		sources:           map[string]string{},
		runtimeNamespaces: map[string]struct{}{},
		runtimeProviders:  map[string]RuntimeProvider{},
		encryptedSecrets:  encryptedSecrets,
		hydratedSecrets:   map[string]any{},
		localVaultCache:   map[string]map[string]string{},
		logicalKeyToVault: map[string]string{},
		vaults:            manifest.Vaults,
		secretFactories:   secretVaultFactoryMap(factories),
	}

	for _, resolved := range graph.Entries {
		entry, err := runtimeEntryFromGraph(resolved)
		if err != nil {
			return nil, err
		}
		runtime.entries[resolved.Key] = entry
		runtime.sources[resolved.Key] = resolved.Winner.SourceID
		if entry.secretRef != nil && entry.secretRef.Vault != "" {
			runtime.logicalKeyToVault[resolved.Key] = entry.secretRef.Vault
		}
	}

	runtime.initializeRuntimeProviders(sortedRuntimeNamespaces(runtime.manifest.RuntimeNamespaces))
	if err := runtime.prepareDerivedEntries(); err != nil {
		return nil, err
	}
	return runtime, nil
}

func (runtime *Runtime) initializeRuntimeProviders(namespaces []string) {
	for _, namespace := range namespaces {
		runtime.runtimeNamespaces[namespace] = struct{}{}
	}
	if _, ok := runtime.runtimeNamespaces["process"]; ok {
		runtime.runtimeProviders["process"] = defaultProcessProvider(runtime.env)
	}
}

func (runtime *Runtime) prepareDerivedEntries() error {
	keys := make([]string, 0)
	for key, entry := range runtime.entries {
		if entry.formula != nil {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)

	resolved := map[string]bool{}
	visiting := map[string]bool{}

	var visit func(string) error
	visit = func(key string) error {
		if resolved[key] {
			return nil
		}
		if visiting[key] {
			return fmt.Errorf("cnos: unable to resolve derived config key %s because of a recursive dependency on %s", key, key)
		}

		entry := runtime.entries[key]
		if entry == nil || entry.formula == nil {
			resolved[key] = true
			return nil
		}

		visiting[key] = true
		runtimeRefs := append([]string(nil), entry.formula.runtimeRefs...)
		runtimeDependent := entry.formula.runtimeDependent

		for _, ref := range entry.formula.refs {
			namespace := namespaceForKey(ref)
			if namespace == "" {
				continue
			}

			if _, ok := runtime.runtimeNamespaces[namespace]; ok {
				runtimeDependent = true
				runtimeRefs = append(runtimeRefs, ref)
				continue
			}

			if dependency := runtime.entries[ref]; dependency != nil && dependency.formula != nil {
				if err := visit(ref); err != nil {
					return err
				}
				if dependency.formula.runtimeDependent {
					runtimeDependent = true
				}
			}
		}

		entry.formula.runtimeRefs = uniqueSortedStrings(runtimeRefs)
		entry.formula.runtimeDependent = runtimeDependent
		entry.formula.deps = filterFormulaDeps(entry.formula.refs, runtime.runtimeNamespaces)
		delete(visiting, key)
		resolved[key] = true
		return nil
	}

	for _, key := range keys {
		if err := visit(key); err != nil {
			return err
		}
	}

	return nil
}

func (runtime *Runtime) populateEntries() error {
	explicitNamespaces := map[string]struct{}{
		"config":  {},
		"flags":   {},
		"process": {},
	}
	for _, namespace := range runtime.projection.Meta.Namespaces {
		explicitNamespaces[namespace] = struct{}{}
	}

	for rawKey, value := range runtime.projection.Values {
		logicalKey := projectionLogicalKey(rawKey, explicitNamespaces)
		runtime.entries[logicalKey] = &runtimeEntry{
			key:       logicalKey,
			namespace: namespaceForKey(logicalKey),
			value:     value,
			winner: runtimeProvenance{
				sourceID:    "server-projection",
				pluginID:    "cnos",
				workspaceID: runtime.projection.Workspace,
			},
		}
		runtime.sources[logicalKey] = "server-projection"
	}

	for rawKey, formula := range runtime.projection.Derived {
		logicalKey := projectionLogicalKey(rawKey, explicitNamespaces)
		parsed, err := parseDerivedFormula(formula)
		if err != nil {
			return fmt.Errorf("cnos: parse derived formula for %s: %w", logicalKey, err)
		}
		runtime.entries[logicalKey] = &runtimeEntry{
			key:       logicalKey,
			namespace: namespaceForKey(logicalKey),
			formula:   &parsed,
			winner: runtimeProvenance{
				sourceID:    "server-projection",
				pluginID:    "cnos",
				workspaceID: runtime.projection.Workspace,
			},
		}
		runtime.sources[logicalKey] = "server-projection"
	}

	for key, ref := range runtime.projection.SecretRefs {
		logicalKey := toLogicalKey("secret", key)
		refCopy := ref
		if refCopy.Vault == "" {
			refCopy.Vault = "default"
		}
		runtime.entries[logicalKey] = &runtimeEntry{
			key:       logicalKey,
			namespace: "secret",
			secretRef: &refCopy,
			winner: runtimeProvenance{
				sourceID:    "server-projection",
				pluginID:    "cnos",
				workspaceID: runtime.projection.Workspace,
			},
		}
		runtime.sources[logicalKey] = "server-projection"
		runtime.logicalKeyToVault[logicalKey] = refCopy.Vault
	}

	for _, key := range runtime.projection.PublicKeys {
		sourceKey := key
		if _, ok := runtime.entries[sourceKey]; !ok {
			sourceKey = toLogicalKey("value", key)
		}
		if _, ok := runtime.entries[sourceKey]; !ok {
			continue
		}

		publicKey := toLogicalKey("public", key)
		runtime.entries[publicKey] = &runtimeEntry{
			key:          publicKey,
			namespace:    "public",
			aliasTo:      sourceKey,
			promotedFrom: sourceKey,
			winner: runtimeProvenance{
				sourceID:    "server-projection",
				pluginID:    "cnos",
				workspaceID: runtime.projection.Workspace,
			},
		}
		runtime.sources[publicKey] = "server-projection"
	}

	metaWinner := runtimeProvenance{
		sourceID:    "server-projection",
		pluginID:    "cnos",
		workspaceID: runtime.projection.Workspace,
	}
	runtime.entries["meta.profile"] = &runtimeEntry{key: "meta.profile", namespace: "meta", value: runtime.projection.Profile, winner: metaWinner}
	runtime.entries["meta.workspace"] = &runtimeEntry{key: "meta.workspace", namespace: "meta", value: runtime.projection.Workspace, winner: metaWinner}
	runtime.entries["meta.cnos_version"] = &runtimeEntry{key: "meta.cnos_version", namespace: "meta", value: runtime.projection.Meta.CnosVersion, winner: metaWinner}
	runtime.sources["meta.profile"] = "server-projection"
	runtime.sources["meta.workspace"] = "server-projection"
	runtime.sources["meta.cnos_version"] = "server-projection"

	return nil
}

func (runtime *Runtime) readInternal(key string, stack map[string]bool) (any, bool, error) {
	entry, ok := runtime.entries[key]
	if !ok {
		if namespace, rest, found := splitLogicalKey(key); found {
			if provider, ok := runtime.runtimeProviders[namespace]; ok {
				return provider(rest), true, nil
			}
		}
		return nil, false, nil
	}

	switch {
	case entry.aliasTo != "":
		return runtime.readInternal(entry.aliasTo, stack)
	case entry.secretRef != nil:
		return runtime.readSecret(entry.key, *entry.secretRef)
	case entry.formula != nil:
		if stack[key] {
			return nil, true, fmt.Errorf("cnos: unable to resolve derived config key %s because of a recursive dependency on %s", key, key)
		}
		if !entry.formula.runtimeDependent && entry.formulaCached {
			return entry.formulaCache, true, nil
		}
		next := copyStack(stack)
		next[key] = true
		value, err := evaluateDerivedFormula(key, *entry.formula, func(ref string) (any, bool, error) {
			return runtime.readInternal(ref, next)
		})
		if err == nil && !entry.formula.runtimeDependent {
			entry.formulaCache = value
			entry.formulaCached = true
		}
		return value, true, err
	default:
		return entry.value, true, nil
	}
}

func (runtime *Runtime) readSecret(key string, ref SecretReference) (any, bool, error) {
	if err := runtime.validateSecretRefVaultProvider(key, ref); err != nil {
		return nil, true, err
	}
	if value, ok := runtime.encryptedSecrets[key]; ok {
		return value, true, nil
	}
	if value, ok := runtime.hydratedSecrets[key]; ok {
		return value, true, nil
	}

	definitions := runtime.secretVaultDefinitions(ref)
	var lastErr error
	for _, definition := range definitions {
		value, found, err := runtime.readSecretWithDefinition(key, ref, definition)
		if err != nil {
			lastErr = err
			continue
		}
		if found && value != nil {
			runtime.hydratedSecrets[key] = value
			return value, true, nil
		}
	}

	if lastErr != nil {
		return nil, true, lastErr
	}

	runtime.hydratedSecrets[key] = nil
	return nil, true, nil
}

func (runtime *Runtime) readSecretWithDefinition(key string, ref SecretReference, definition vaultDefinition) (any, bool, error) {
	switch definition.Provider {
	case "environment", "github-secrets":
		return runtime.readEnvironmentSecretWithDefinition(ref, definition), true, nil
	case "local":
		secrets, err := runtime.localVaultSecrets(ref.Vault)
		if err != nil {
			return nil, true, err
		}
		value, ok := secrets[ref.Ref]
		if !ok {
			return nil, true, nil
		}
		return value, true, nil
	default:
		if _, ok := runtime.secretFactories[definition.Provider]; !ok {
			return nil, true, fmt.Errorf("cnos: unsupported vault provider: %s", definition.Provider)
		}
		if err := runtime.hydrateCustomVault(ref.Vault, definition, runtime.refsForVaultCandidate(ref.Vault, definition)); err != nil {
			return nil, true, err
		}
		return runtime.hydratedSecrets[key], true, nil
	}
}

func (runtime *Runtime) secretVaultDefinitions(ref SecretReference) []vaultDefinition {
	definition := runtime.secretVaultDefinition(ref)
	return append([]vaultDefinition{definition}, definition.Fallback...)
}

func (runtime *Runtime) secretVaultDefinition(ref SecretReference) vaultDefinition {
	if definition, ok := runtime.vaults[ref.Vault]; ok {
		if definition.Provider == "" {
			definition.Provider = ref.Provider
		}
		return definition
	}
	provider := ref.Provider
	if provider == "" {
		provider = "local"
	}
	return vaultDefinition{
		Provider: provider,
		Auth: vaultAuthFile{
			Method: defaultVaultMethod(provider),
		},
		Mapping: map[string]string{},
	}
}

func (runtime *Runtime) validateSecretRefVaultProvider(key string, ref SecretReference) error {
	if ref.Vault == "" || ref.Provider == "" {
		return nil
	}
	definition, ok := runtime.vaults[ref.Vault]
	if !ok || definition.Provider == "" || definition.Provider == ref.Provider {
		return nil
	}
	return fmt.Errorf("cnos: secret ref %q declares provider %q but vault %q uses provider %q", key, ref.Provider, ref.Vault, definition.Provider)
}

func (runtime *Runtime) refsForVaultCandidate(vaultID string, definition vaultDefinition) map[string]string {
	refsByLogicalKey := map[string]string{}
	for key, entry := range runtime.entries {
		if entry == nil || entry.secretRef == nil || entry.secretRef.Vault != vaultID {
			continue
		}
		if _, alreadyHydrated := runtime.hydratedSecrets[key]; alreadyHydrated {
			continue
		}
		for _, candidate := range runtime.secretVaultDefinitions(*entry.secretRef) {
			if candidate.Provider == definition.Provider {
				refsByLogicalKey[key] = entry.secretRef.Ref
				break
			}
		}
	}
	return refsByLogicalKey
}

func (runtime *Runtime) hydrateCustomVault(vaultID string, definition vaultDefinition, refsByLogicalKey map[string]string) error {
	factory, ok := runtime.secretFactories[definition.Provider]
	if !ok {
		return fmt.Errorf("cnos: unsupported vault provider: %s", definition.Provider)
	}

	refs := []string{}
	seen := map[string]bool{}
	for _, ref := range refsByLogicalKey {
		if !seen[ref] {
			seen[ref] = true
			refs = append(refs, ref)
		}
	}
	sort.Strings(refs)

	provider, err := factory.Create(vaultID, vaultDefinitionForProvider(definition))
	if err != nil {
		return fmt.Errorf("cnos: create vault provider %q for vault %q: %w", definition.Provider, vaultID, err)
	}
	if provider == nil {
		return fmt.Errorf("cnos: create vault provider %q for vault %q returned nil", definition.Provider, vaultID)
	}
	auth, err := resolveVaultAuth(vaultID, definition, runtime.env)
	if err != nil {
		return err
	}
	if err := provider.Authenticate(auth); err != nil {
		return fmt.Errorf("cnos: authenticate vault %q with provider %q: %w", vaultID, definition.Provider, err)
	}
	values, err := provider.BatchGet(refs)
	if err != nil {
		return fmt.Errorf("cnos: batch get secrets from vault %q with provider %q: %w", vaultID, definition.Provider, err)
	}
	for key, ref := range refsByLogicalKey {
		if _, alreadyHydrated := runtime.hydratedSecrets[key]; alreadyHydrated {
			continue
		}
		if value := values[ref]; value != nil {
			runtime.hydratedSecrets[key] = value
		}
	}
	return nil
}

func (runtime *Runtime) readEnvironmentSecret(ref SecretReference) any {
	if value, ok := runtime.env.Get(ref.Ref); ok {
		return value
	}
	if ref.EnvVar != "" {
		if value, ok := runtime.env.Get(ref.EnvVar); ok {
			return value
		}
	}
	if definition, ok := runtime.vaults[ref.Vault]; ok {
		for envVar, logicalRef := range definition.Mapping {
			if logicalRef == ref.Ref {
				if value, ok := runtime.env.Get(envVar); ok {
					return value
				}
				break
			}
		}
	}
	return nil
}

func (runtime *Runtime) readEnvironmentSecretWithDefinition(ref SecretReference, definition vaultDefinition) any {
	if value, ok := runtime.env.Get(ref.Ref); ok {
		return value
	}
	if ref.EnvVar != "" {
		if value, ok := runtime.env.Get(ref.EnvVar); ok {
			return value
		}
	}
	for envVar, logicalRef := range definition.Mapping {
		if logicalRef == ref.Ref {
			if value, ok := runtime.env.Get(envVar); ok {
				return value
			}
			break
		}
	}
	return nil
}

func (runtime *Runtime) localVaultSecrets(vault string) (map[string]string, error) {
	if secrets, ok := runtime.localVaultCache[vault]; ok {
		return secrets, nil
	}

	var definition *vaultDefinition
	if resolved, ok := runtime.vaults[vault]; ok {
		copy := resolved
		definition = &copy
	}

	secrets, err := readLocalVaultSecrets(runtime.secretHome, vault, definition, runtime.env)
	if err != nil {
		return nil, err
	}

	runtime.localVaultCache[vault] = secrets
	return secrets, nil
}

func projectionLogicalKey(raw string, explicitNamespaces map[string]struct{}) string {
	if strings.HasPrefix(raw, "value.") || strings.HasPrefix(raw, "public.") {
		return raw
	}
	first := strings.Split(raw, ".")[0]
	if _, ok := explicitNamespaces[first]; ok {
		return raw
	}
	return toLogicalKey("value", raw)
}

func defaultProcessProvider(env environment) RuntimeProvider {
	return func(path string) any {
		segments := strings.Split(path, ".")
		if len(segments) > 1 && segments[0] == "env" {
			if value, ok := env.Get(strings.Join(segments[1:], ".")); ok {
				return value
			}
			return nil
		}

		switch path {
		case "cwd":
			cwd, err := os.Getwd()
			if err != nil {
				return nil
			}
			resolved, err := filepath.Abs(cwd)
			if err != nil {
				return cwd
			}
			return resolved
		case "platform":
			return nodePlatform()
		case "arch":
			return nodeArch()
		case "pid":
			return os.Getpid()
		default:
			return nil
		}
	}
}

func namespaceForKey(key string) string {
	if namespace, _, ok := splitLogicalKey(key); ok {
		return namespace
	}
	return ""
}

func splitLogicalKey(key string) (string, string, bool) {
	namespace, rest, ok := strings.Cut(key, ".")
	return namespace, rest, ok
}

func toLogicalKey(namespace, valuePath string) string {
	// Idempotency guard: already-prefixed key passes through unchanged.
	if strings.HasPrefix(valuePath, namespace+".") {
		return valuePath
	}
	parts := []string{}
	for _, chunk := range strings.Split(valuePath, ".") {
		chunk = strings.TrimSpace(chunk)
		if chunk != "" {
			parts = append(parts, chunk)
		}
	}
	return namespace + "." + strings.Join(parts, ".")
}

func copyStack(source map[string]bool) map[string]bool {
	copy := make(map[string]bool, len(source))
	for key, value := range source {
		copy[key] = value
	}
	return copy
}

func cloneAnyMap(source map[string]any) map[string]any {
	result := make(map[string]any, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func cloneLocalVaultCache(source map[string]map[string]string) map[string]map[string]string {
	result := make(map[string]map[string]string, len(source))
	for vault, secrets := range source {
		secretsCopy := make(map[string]string, len(secrets))
		for key, value := range secrets {
			secretsCopy[key] = value
		}
		result[vault] = secretsCopy
	}
	return result
}

func IsProjectionNotFound(err error) bool {
	return errors.Is(err, ErrProjectionNotFound)
}

func filterFormulaDeps(refs []string, runtimeNamespaces map[string]struct{}) []string {
	deps := make([]string, 0, len(refs))
	for _, ref := range refs {
		namespace := namespaceForKey(ref)
		if namespace == "" {
			continue
		}
		if _, ok := runtimeNamespaces[namespace]; ok {
			continue
		}
		deps = append(deps, ref)
	}
	return uniqueSortedStrings(deps)
}

func (runtime *Runtime) warmSecrets() error {
	keys := make([]string, 0)
	for key, entry := range runtime.entries {
		if entry.secretRef != nil {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	for _, key := range keys {
		entry := runtime.entries[key]
		if entry == nil || entry.secretRef == nil {
			continue
		}
		if _, _, err := runtime.readSecret(key, *entry.secretRef); err != nil {
			return err
		}
	}
	return nil
}
