package cnos

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

type ToEnvOptions struct {
	IncludeSecrets bool
}

type ToPublicEnvOptions struct {
	Framework string
	Prefix    string
}

func (runtime *Runtime) ReadOr(key string, fallback any) (any, error) {
	value, ok, err := runtime.Read(key)
	if err != nil {
		return nil, err
	}
	if !ok {
		return fallback, nil
	}
	return value, nil
}

func (runtime *Runtime) ToObject() (map[string]any, error) {
	return runtime.toNamespaceObject("")
}

func (runtime *Runtime) ToNamespace(namespace string) (map[string]any, error) {
	return runtime.toNamespaceObject(strings.TrimSpace(namespace))
}

func (runtime *Runtime) ToEnv(options ...ToEnvOptions) (map[string]string, error) {
	config := ToEnvOptions{}
	if len(options) > 0 {
		config = options[0]
	}

	output := map[string]string{}
	keys := make([]string, 0, len(runtime.manifest.EnvMapping.Explicit))
	for envVar := range runtime.manifest.EnvMapping.Explicit {
		keys = append(keys, envVar)
	}
	sort.Strings(keys)

	for _, envVar := range keys {
		logicalKey := runtime.manifest.EnvMapping.Explicit[envVar]
		entry := runtime.entries[logicalKey]
		if entry == nil {
			continue
		}

		definition := runtime.namespaceDefinition(entry.namespace)
		if definition.Kind != "data" {
			continue
		}
		if entry.namespace == "secret" {
			if !config.IncludeSecrets {
				continue
			}
		} else if !definition.Shareable || definition.Sensitive {
			continue
		}

		value, ok, err := runtime.Read(logicalKey)
		if err != nil {
			return nil, err
		}
		if !ok || value == nil {
			continue
		}
		output[envVar] = normalizeEnvValue(value)
	}

	return output, nil
}

func (runtime *Runtime) ToPublicEnv(options ...ToPublicEnvOptions) (map[string]string, error) {
	config := ToPublicEnvOptions{}
	if len(options) > 0 {
		config = options[0]
	}

	prefix, err := runtime.resolvePublicPrefix(config)
	if err != nil {
		return nil, err
	}

	output := map[string]string{}
	keys := make([]string, 0)
	for key, entry := range runtime.entries {
		if entry.namespace == "public" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)

	for _, key := range keys {
		sourceKey := runtime.resolveProjectedSourceKey(key)
		if source := runtime.entries[sourceKey]; source != nil && source.formula != nil && source.formula.runtimeDependent {
			value, ok, err := runtime.Read(key)
			if err != nil {
				return nil, err
			}
			if !ok || value == nil {
				return nil, fmt.Errorf("cnos: cannot build public output for %s because it depends on runtime-only values", key)
			}
		}

		value, ok, err := runtime.Read(key)
		if err != nil {
			return nil, err
		}
		if !ok || value == nil {
			continue
		}

		baseEnvVar := fallbackPublicEnvVar(strings.TrimPrefix(key, "public."))
		envVar := baseEnvVar
		if prefix != "" && !strings.HasPrefix(baseEnvVar, prefix) {
			envVar = prefix + baseEnvVar
		}
		output[envVar] = normalizeEnvValue(value)
	}

	return output, nil
}

func (runtime *Runtime) ToServerProjection() (ServerProjection, error) {
	if runtime.graphBootstrapped {
		return ServerProjection{}, fmt.Errorf("cnos: runtime graph bootstrap payload does not support server projection export")
	}
	if runtime.projection.Version == 1 && runtime.projection.ResolvedAt != "" && runtime.projection.ConfigHash != "" {
		return runtime.projection, nil
	}

	values := map[string]any{}
	derived := map[string]DerivedFormula{}
	secretRefs := map[string]SecretReference{}
	publicKeys := make([]string, 0)
	namespaces := map[string]struct{}{}
	runtimeNamespaces := map[string]struct{}{}

	keys := make([]string, 0, len(runtime.entries))
	for key := range runtime.entries {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	for _, key := range keys {
		entry := runtime.entries[key]
		if entry == nil || entry.namespace == "meta" || entry.namespace == "public" {
			continue
		}

		if entry.secretRef != nil {
			ref := *entry.secretRef
			if ref.Provider == "" {
				ref.Provider = runtime.secretVaultDefinition(ref).Provider
			}
			if ref.EnvVar == "" {
				ref.EnvVar = runtime.logicalRefToMappedEnvVar(ref.Vault, ref.Ref)
			}
			secretRefs[strings.TrimPrefix(key, "secret.")] = ref
			continue
		}

		definition := runtime.namespaceDefinition(entry.namespace)
		if definition.Kind != "data" || definition.Sensitive {
			continue
		}
		if runtime.sources[key] == "process-env" {
			continue
		}

		projectedKey := key
		if entry.namespace == "value" {
			projectedKey = strings.TrimPrefix(key, "value.")
		} else {
			namespaces[entry.namespace] = struct{}{}
		}

		if entry.formula != nil {
			if entry.formula.runtimeDependent {
				derived[projectedKey] = DerivedFormula{
					Expr:        entry.formula.raw,
					Deps:        append([]string(nil), entry.formula.deps...),
					RuntimeRefs: append([]string(nil), entry.formula.runtimeRefs...),
				}
				for _, ref := range entry.formula.runtimeRefs {
					namespace := namespaceForKey(ref)
					if namespace != "" {
						runtimeNamespaces[namespace] = struct{}{}
					}
				}
				continue
			}
		}

		value, ok, err := runtime.Read(key)
		if err != nil {
			return ServerProjection{}, err
		}
		if !ok {
			continue
		}
		values[projectedKey] = value
	}

	for _, key := range keys {
		entry := runtime.entries[key]
		if entry != nil && entry.namespace == "public" {
			publicKeys = append(publicKeys, strings.TrimPrefix(key, "public."))
		}
	}

	namespaceList := sortedStringSet(namespaces)
	runtimeNamespaceList := sortedStringSet(runtimeNamespaces)
	projection := ServerProjection{
		Version:           1,
		Workspace:         runtime.profileWorkspace("workspace"),
		Profile:           runtime.profileWorkspace("profile"),
		ResolvedAt:        firstNonEmpty(runtime.projection.ResolvedAt),
		ConfigHash:        configHash(values),
		Values:            stableSortAnyMap(values),
		Derived:           stableSortFormulaMap(derived),
		SecretRefs:        stableSortSecretRefMap(secretRefs),
		Vaults:            stableSortVaultMap(projectReferencedVaults(secretRefs, runtime.manifest.Vaults)),
		PublicKeys:        publicKeys,
		RuntimeNamespaces: runtimeNamespaceList,
		Meta: ProjectionMeta{
			Workspace:   runtime.profileWorkspace("workspace"),
			Profile:     runtime.profileWorkspace("profile"),
			CnosVersion: firstNonEmpty(runtime.projection.Meta.CnosVersion, "authoring-runtime"),
			Namespaces:  namespaceList,
		},
	}
	if projection.ResolvedAt == "" {
		projection.ResolvedAt = time.Now().UTC().Format(time.RFC3339)
	}
	runtime.projection = projection
	return projection, nil
}

func (runtime *Runtime) Format(message string) (string, error) {
	return formatRuntimeMessage(runtime, message)
}

func (runtime *Runtime) Log(message string) (string, error) {
	formatted, err := formatRuntimeMessage(runtime, message)
	if err != nil {
		return "", err
	}
	fmt.Println(formatted)
	return formatted, nil
}

func (runtime *Runtime) toNamespaceObject(namespace string) (map[string]any, error) {
	output := map[string]any{}
	keys := make([]string, 0, len(runtime.entries))
	for key := range runtime.entries {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	for _, key := range keys {
		entry := runtime.entries[key]
		if entry == nil {
			continue
		}
		if namespace != "" && entry.namespace != namespace {
			continue
		}

		value, ok, err := runtime.Read(key)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}

		targetPath := key
		if namespace != "" {
			targetPath = strings.TrimPrefix(key, namespace+".")
		}
		setNestedValue(output, strings.Split(targetPath, "."), value)
	}

	return output, nil
}

func (runtime *Runtime) namespaceDefinition(namespace string) namespaceDefinition {
	if definition, ok := runtime.manifest.Namespaces[namespace]; ok {
		return definition
	}
	if definition, ok := defaultNamespaceDefs[namespace]; ok {
		return definition
	}
	return namespaceDefinition{Kind: "data"}
}

func (runtime *Runtime) resolvePublicPrefix(options ToPublicEnvOptions) (string, error) {
	if options.Prefix != "" {
		return options.Prefix, nil
	}
	if options.Framework == "" {
		return "", nil
	}
	prefix, ok := runtime.manifest.Frameworks[options.Framework]
	if !ok {
		return "", fmt.Errorf("cnos: unknown public framework prefix: %s", options.Framework)
	}
	return prefix, nil
}

func (runtime *Runtime) resolveProjectedSourceKey(key string) string {
	if entry := runtime.entries[key]; entry != nil {
		if entry.aliasTo != "" {
			return entry.aliasTo
		}
		if entry.promotedFrom != "" {
			return entry.promotedFrom
		}
	}
	if strings.HasPrefix(key, "public.") {
		fallback := "value." + strings.TrimPrefix(key, "public.")
		if runtime.entries[fallback] != nil {
			return fallback
		}
	}
	return key
}

func (runtime *Runtime) logicalRefToMappedEnvVar(vaultID, ref string) string {
	mapping := runtime.manifest.Vaults[vaultID].Mapping
	for envVar, logicalRef := range mapping {
		if logicalRef == ref {
			return envVar
		}
	}
	return ""
}

func (runtime *Runtime) profileWorkspace(kind string) string {
	switch kind {
	case "workspace":
		if value, ok, err := runtime.Meta("workspace"); err == nil && ok {
			if text, ok := value.(string); ok {
				return text
			}
		}
	case "profile":
		if value, ok, err := runtime.Meta("profile"); err == nil && ok {
			if text, ok := value.(string); ok {
				return text
			}
		}
	case "resolvedAt":
		return runtime.projection.ResolvedAt
	}
	return ""
}

func bootstrappedManifestFromProjection(projection ServerProjection) authoringManifest {
	namespaces := map[string]namespaceDefinition{}
	for key, value := range defaultNamespaceDefs {
		namespaces[key] = value
	}
	for _, namespace := range projection.Meta.Namespaces {
		if _, ok := namespaces[namespace]; !ok {
			namespaces[namespace] = namespaceDefinition{Kind: "data"}
		}
	}

	runtimeNamespaces := map[string]runtimeNamespaceDefinition{
		"process": {
			Description: "Live process runtime values.",
			ServerOnly:  true,
			BuiltIn:     true,
		},
	}
	for _, namespace := range projection.RuntimeNamespaces {
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
		EnvMapping:        envMappingConfig{Explicit: map[string]string{}},
		Frameworks:        frameworks,
		Namespaces:        namespaces,
		RuntimeNamespaces: runtimeNamespaces,
		Vaults:            stableSortVaultMap(projection.Vaults),
	}
}

func formatRuntimeMessage(runtime *Runtime, message string) (string, error) {
	var err error
	formatted := templatePattern.ReplaceAllStringFunc(message, func(token string) string {
		if err != nil {
			return token
		}
		match := templatePattern.FindStringSubmatch(token)
		if len(match) < 2 {
			return token
		}
		key := strings.TrimSpace(match[1])
		if key == "" {
			return token
		}
		value, ok, readErr := runtime.Read(key)
		if readErr != nil {
			err = readErr
			return token
		}
		if !ok {
			return token
		}
		return stringifyLogValue(value)
	})
	if err != nil {
		return "", err
	}
	return formatted, nil
}

func setNestedValue(target map[string]any, pathSegments []string, value any) {
	if len(pathSegments) == 0 || pathSegments[0] == "" {
		return
	}
	head := pathSegments[0]
	if len(pathSegments) == 1 {
		target[head] = value
		return
	}

	current, ok := target[head].(map[string]any)
	if !ok {
		current = map[string]any{}
		target[head] = current
	}
	setNestedValue(current, pathSegments[1:], value)
}

func normalizeEnvValue(value any) string {
	return jsStringifyValue(value)
}

func fallbackPublicEnvVar(valuePath string) string {
	var builder strings.Builder
	lastUnderscore := false
	for index, char := range valuePath {
		switch {
		case char >= 'a' && char <= 'z':
			if index > 0 && lastWasLowerAlphaNum(valuePath, index-1) && isUpperAhead(valuePath, index) {
				if !lastUnderscore {
					builder.WriteByte('_')
				}
			}
			builder.WriteRune(char - 32)
			lastUnderscore = false
		case char >= 'A' && char <= 'Z':
			if index > 0 && lastWasLowerAlphaNum(valuePath, index-1) && !lastUnderscore {
				builder.WriteByte('_')
			}
			builder.WriteRune(char)
			lastUnderscore = false
		case char >= '0' && char <= '9':
			builder.WriteRune(char)
			lastUnderscore = false
		default:
			if !lastUnderscore {
				builder.WriteByte('_')
				lastUnderscore = true
			}
		}
	}
	return strings.Trim(builder.String(), "_")
}

func lastWasLowerAlphaNum(value string, index int) bool {
	if index < 0 || index >= len(value) {
		return false
	}
	char := value[index]
	return (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')
}

func isUpperAhead(value string, index int) bool {
	if index+1 >= len(value) {
		return false
	}
	next := value[index+1]
	return next >= 'A' && next <= 'Z'
}

func configHash(values map[string]any) string {
	sum := sha256.Sum256([]byte(stableJSONString(values)))
	return hex.EncodeToString(sum[:])
}

func stableJSONString(value map[string]any) string {
	encoded, err := json.Marshal(stableSortAnyMap(value))
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

func stableSortAnyMap(value map[string]any) map[string]any {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	sorted := map[string]any{}
	for _, key := range keys {
		sorted[key] = stableSortAnyValue(value[key])
	}
	return sorted
}

func stableSortAnyValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return stableSortAnyMap(typed)
	case []any:
		items := make([]any, len(typed))
		for index, item := range typed {
			items[index] = stableSortAnyValue(item)
		}
		return items
	default:
		return value
	}
}

func stableSortFormulaMap(value map[string]DerivedFormula) map[string]DerivedFormula {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	sorted := map[string]DerivedFormula{}
	for _, key := range keys {
		sorted[key] = value[key]
	}
	return sorted
}

func stableSortSecretRefMap(value map[string]SecretReference) map[string]SecretReference {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	sorted := map[string]SecretReference{}
	for _, key := range keys {
		sorted[key] = value[key]
	}
	return sorted
}

func stableSortStringMap(value map[string]string) map[string]string {
	if len(value) == 0 {
		return nil
	}
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	sorted := map[string]string{}
	for _, key := range keys {
		sorted[key] = value[key]
	}
	return sorted
}

func projectReferencedVaults(secretRefs map[string]SecretReference, vaults map[string]vaultDefinition) map[string]vaultDefinition {
	projected := map[string]vaultDefinition{}
	for _, ref := range secretRefs {
		if definition, ok := vaults[ref.Vault]; ok {
			projected[ref.Vault] = projectVaultDefinition(definition)
		}
	}
	return projected
}

func projectVaultDefinition(definition vaultDefinition) vaultDefinition {
	projected := vaultDefinition{
		Provider: definition.Provider,
		Mapping:  stableSortStringMap(definition.Mapping),
	}

	projected.Auth = projectVaultAuth(definition.Auth)
	for _, fallback := range definition.Fallback {
		projected.Fallback = append(projected.Fallback, projectVaultDefinition(fallback))
	}
	return projected
}

func projectVaultAuth(auth vaultAuthFile) vaultAuthFile {
	return vaultAuthFile{
		Method:     auth.Method,
		Passphrase: cloneVaultAuthSource(auth.Passphrase),
		Token:      cloneVaultAuthSource(auth.Token),
		Config:     sanitizeProjectedConfig(auth.Config),
	}
}

func cloneVaultAuthSource(source *vaultAuthSourceFile) *vaultAuthSourceFile {
	if source == nil {
		return nil
	}
	return &vaultAuthSourceFile{From: append([]string(nil), source.From...)}
}

var safeProjectedConfigKeys = map[string]struct{}{
	"address":             {},
	"audience":            {},
	"clientid":            {},
	"endpoint":            {},
	"mount":               {},
	"namespace":           {},
	"path":                {},
	"projectid":           {},
	"region":              {},
	"scope":               {},
	"scopes":              {},
	"serviceaccountemail": {},
	"tenant":              {},
	"tenantid":            {},
	"url":                 {},
	"version":             {},
	"vaulturl":            {},
}

func sanitizeProjectedConfig(config map[string]any) map[string]any {
	sanitized, ok := sanitizeProjectedConfigValue(config).(map[string]any)
	if !ok || len(sanitized) == 0 {
		return nil
	}
	return sanitized
}

func sanitizeProjectedConfigValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		output := map[string]any{}
		for key, item := range typed {
			sanitized := sanitizeProjectedConfigValue(item)
			if nested, ok := sanitized.(map[string]any); ok {
				if len(nested) > 0 {
					output[key] = nested
				}
				continue
			}
			if _, ok := safeProjectedConfigKeys[normalizeProjectedConfigKey(key)]; ok {
				output[key] = sanitized
			}
		}
		return stableSortAnyMap(output)
	case []any:
		items := make([]any, len(typed))
		for index, item := range typed {
			items[index] = sanitizeProjectedConfigValue(item)
		}
		return items
	default:
		return value
	}
}

func normalizeProjectedConfigKey(key string) string {
	var builder strings.Builder
	for _, char := range key {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') {
			builder.WriteRune(char)
		}
	}
	return strings.ToLower(builder.String())
}

func stableSortVaultMap(value map[string]vaultDefinition) map[string]vaultDefinition {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	sorted := map[string]vaultDefinition{}
	for _, key := range keys {
		sorted[key] = value[key]
	}
	return sorted
}

func sortedStringSet(values map[string]struct{}) []string {
	items := make([]string, 0, len(values))
	for value := range values {
		if value != "" {
			items = append(items, value)
		}
	}
	sort.Strings(items)
	return items
}

func stringifyLogValue(value any) string {
	return jsLogStringifyValue(value)
}

var templatePattern = regexp.MustCompile(`\$\{([^}]+)\}`)
