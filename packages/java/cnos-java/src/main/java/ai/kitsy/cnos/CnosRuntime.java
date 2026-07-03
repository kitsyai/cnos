package ai.kitsy.cnos;

import ai.kitsy.cnos.internal.*;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * The CNOS Java runtime — consumes a pre-built server projection and provides typed read APIs.
 *
 * <p>Obtain an instance via {@link #load(CnosOptions)} or the static factory methods on {@link Cnos}.
 */
public final class CnosRuntime {

    // Env var constants mirroring Go's projection.go
    private static final String PROJECTION_ENV_VAR = "__CNOS_PROJECTION__";
    private static final String GRAPH_ENV_VAR = "__CNOS_GRAPH__";
    private static final String SECRET_PAYLOAD_ENV_VAR = "__CNOS_SECRET_PAYLOAD__";
    private static final String SESSION_KEY_ENV_VAR = "__CNOS_SESSION_KEY__";
    private static final String PROJECTION_FILE_NAME = ".cnos-server.json";
    private static final String CNOSRC_FILE_NAME = ".cnosrc.yml";

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Pattern TEMPLATE_PATTERN = Pattern.compile("\\$\\{([^}]+)\\}");

    // --- Runtime state ---
    private final ServerProjection projection;
    private final BootstrappedManifest manifest;
    private final String profileSource;
    private final WorkspaceState workspaceState;
    private final boolean graphBootstrapped;
    private final Environment env;
    private final String secretHome;
    private final Map<String, RuntimeEntry> entries;
    private final Map<String, String> sources;
    private final Set<String> runtimeNamespaces;
    private final Map<String, java.util.function.Function<String, Object>> runtimeProviders;
    private final Map<String, Object> encryptedSecrets;
    private final Map<String, Object> hydratedSecrets;
    private final Map<String, Map<String, String>> localVaultCache;
    private final Map<String, String> logicalKeyToVault;
    private final Map<String, VaultDefinition> vaults;
    private final Map<String, SecretVaultProviderFactory> secretFactories;
    private final Map<String, String> parsedArgs;
    private final Map<String, Object> fileOverrides;

    // --- Constructor ---
    private CnosRuntime(Builder b) {
        this.projection = b.projection;
        this.manifest = b.manifest;
        this.profileSource = b.profileSource;
        this.workspaceState = b.workspaceState;
        this.graphBootstrapped = b.graphBootstrapped;
        this.env = b.env;
        this.secretHome = b.secretHome;
        this.entries = b.entries;
        this.sources = b.sources;
        this.runtimeNamespaces = b.runtimeNamespaces;
        this.runtimeProviders = b.runtimeProviders;
        this.encryptedSecrets = b.encryptedSecrets;
        this.hydratedSecrets = b.hydratedSecrets;
        this.localVaultCache = b.localVaultCache;
        this.logicalKeyToVault = b.logicalKeyToVault;
        this.vaults = b.vaults;
        this.secretFactories = b.secretFactories;
        this.parsedArgs = b.parsedArgs != null ? b.parsedArgs : Collections.emptyMap();
        this.fileOverrides = b.fileOverrides != null ? b.fileOverrides : Collections.emptyMap();
    }

    // ================================================================
    // Static factory
    // ================================================================

    /**
     * Loads a runtime according to the discovery order:
     * <ol>
     *   <li>Explicit projectionData bytes or projectionPath in options</li>
     *   <li>{@code __CNOS_GRAPH__} env var</li>
     *   <li>{@code __CNOS_PROJECTION__} env var</li>
     *   <li>{@code .cnos-server.json} file discovered from working directory</li>
     * </ol>
     *
     * @param options load options
     * @return initialized runtime
     * @throws CnosError if no projection is found or loading fails
     */
    public static CnosRuntime load(CnosOptions options) throws CnosError {
        if (options == null) options = CnosOptions.defaults();
        Environment env = Environment.of(options.getEnvironment());
        String secretHome = resolveSecretHome(env, options.getSecretHome());
        List<SecretVaultProviderFactory> factories = options.getSecretVaultProviders();

        // 1. Explicit projection data bytes
        if (options.getProjectionData() != null && options.getProjectionData().length > 0) {
            return newRuntime(options.getProjectionData(), env, secretHome, factories);
        }

        // 2. Explicit projection file path
        if (options.getProjectionPath() != null && !options.getProjectionPath().isEmpty()) {
            String resolvedPath = resolvePathFromWorkingDir(options.getWorkingDir(), options.getProjectionPath());
            byte[] data = readFile(resolvedPath);
            return newRuntime(data, env, secretHome, factories);
        }

        // 3. __CNOS_GRAPH__ env var
        Optional<String> graphEnv = env.get(GRAPH_ENV_VAR);
        if (graphEnv.isPresent() && !graphEnv.get().isEmpty()) {
            return newRuntimeFromGraph(graphEnv.get().getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    env, secretHome, factories);
        }

        // 4. __CNOS_PROJECTION__ env var
        Optional<String> projEnv = env.get(PROJECTION_ENV_VAR);
        if (projEnv.isPresent() && !projEnv.get().isEmpty()) {
            return newRuntime(projEnv.get().getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    env, secretHome, factories);
        }

        // 5. .cnos-server.json file discovery
        String projectionPath = findProjectionPath(options.getWorkingDir());
        if (projectionPath != null) {
            byte[] data = readFile(projectionPath);
            return newRuntime(data, env, secretHome, factories);
        }

        throw new CnosError(CnosError.PROJECTION_NOT_FOUND);
    }

    /** Loads from explicit projection bytes. */
    public static CnosRuntime loadProjection(byte[] data, CnosOptions options) throws CnosError {
        if (options == null) options = CnosOptions.defaults();
        return load(CnosOptions.builder()
                .projectionData(data)
                .workingDir(options.getWorkingDir())
                .environment(options.getEnvironment())
                .secretHome(options.getSecretHome())
                .secretVaultProviders(options.getSecretVaultProviders())
                .build());
    }

    // ================================================================
    // Public API
    // ================================================================

    /** Returns the underlying ServerProjection (only valid when not graph-bootstrapped). */
    public ServerProjection getProjection() { return projection; }

    /**
     * Reads any config key by its logical form (e.g. {@code value.server.port}).
     *
     * @return Optional containing the value, or empty if the key is absent
     * @throws CnosError on derived formula or secret hydration failure
     */
    public Optional<Object> read(String key) throws CnosError {
        if (key.startsWith("value.") && projection != null
                && !projection.getOverrides().isEmpty()) {
            String stripped = key.substring("value.".length());
            ServerProjection.OverrideSpec spec = projection.getOverrides().get(stripped);
            if (spec != null) {
                // File override participates as the "cnos" source.
                Object[] cnos = fileOrCnos(key);
                Object cnosVal = cnos[0];
                boolean cnosFound = (Boolean) cnos[1];
                return applyOverride(spec, cnosVal, cnosFound, parsedArgs, env, key);
            }
        }
        // No OverrideSpec: file then CNOS.
        if (fileOverrides.containsKey(key)) {
            return Optional.ofNullable(fileOverrides.get(key));
        }
        Object[] result = readInternal(key, new HashSet<>());
        boolean found = (Boolean) result[1];
        return found ? Optional.ofNullable(result[0]) : Optional.empty();
    }

    private Object[] fileOrCnos(String key) throws CnosError {
        if (fileOverrides.containsKey(key)) {
            return new Object[]{fileOverrides.get(key), Boolean.TRUE};
        }
        return readInternal(key, new HashSet<>());
    }

    /**
     * Reads a required key, throwing if absent.
     *
     * @throws CnosError if the key is missing
     */
    public Object require(String key) throws CnosError {
        Object[] result = readInternal(key, new HashSet<>());
        boolean found = (Boolean) result[1];
        if (!found) throw new CnosError(CnosError.MISSING_KEY + ": " + key);
        return result[0];
    }

    /** Reads a key, returning {@code fallback} if absent. */
    public Object readOr(String key, Object fallback) throws CnosError {
        Object[] result = readInternal(key, new HashSet<>());
        boolean found = (Boolean) result[1];
        return found ? result[0] : fallback;
    }

    /** Reads a {@code value.*} key by its sub-path. */
    public Optional<Object> value(String path) throws CnosError {
        return read(toLogicalKey("value", path));
    }

    /** Reads a {@code secret.*} key by its sub-path. */
    public Optional<Object> secret(String path) throws CnosError {
        return read(toLogicalKey("secret", path));
    }

    /** Reads a {@code meta.*} key by its sub-path. */
    public Optional<Object> meta(String path) throws CnosError {
        return read(toLogicalKey("meta", path));
    }

    /** Reads a {@code public.*} key by its sub-path. */
    public Optional<Object> publicKey(String path) throws CnosError {
        return read(toLogicalKey("public", path));
    }

    /**
     * Returns the value at path as a map or list, parsing string values as JSON.
     */
    public Optional<Object> json(String path) throws CnosError {
        Optional<Object> raw = value(path);
        if (raw.isEmpty()) return Optional.empty();
        if (raw.get() instanceof String) {
            try {
                return Optional.of(new ObjectMapper().readValue((String) raw.get(), Object.class));
            } catch (Exception e) {
                return Optional.empty();
            }
        }
        return raw;
    }

    /**
     * Returns the value at path as a PEM string, normalising literal \n sequences to real newlines.
     * Checks value.* first, then secret.*.
     */
    public Optional<String> pem(String path) throws CnosError {
        Optional<Object> raw = value(path);
        if (raw.isEmpty()) raw = secret(path);
        if (raw.isEmpty() || !(raw.get() instanceof String)) return Optional.empty();
        return Optional.of(((String) raw.get()).replace("\\n", "\n"));
    }

    /**
     * Returns all resolved config values as a nested map, keyed by full logical key path.
     */
    public Map<String, Object> toObject() throws CnosError {
        return toNamespaceObject("");
    }

    /**
     * Returns all resolved config values for a specific namespace as a nested map.
     */
    public Map<String, Object> toNamespace(String namespace) throws CnosError {
        return toNamespaceObject(namespace != null ? namespace.trim() : "");
    }

    /**
     * Returns env-mapping entries as KEY=VALUE pairs.
     * Only exports entries in the explicit env mapping; secrets excluded unless includeSecrets=true.
     */
    public Map<String, String> toEnv(ToEnvOptions options) throws CnosError {
        if (options == null) options = new ToEnvOptions();
        Map<String, String> output = new LinkedHashMap<>();
        List<String> envVars = new ArrayList<>(manifest.getEnvMappingExplicit().keySet());
        Collections.sort(envVars);

        for (String envVar : envVars) {
            String logicalKey = manifest.getEnvMappingExplicit().get(envVar);
            RuntimeEntry entry = entries.get(logicalKey);
            if (entry == null) continue;

            BootstrappedManifest.NamespaceDef def = manifest.getNamespaceDef(entry.getNamespace());
            if (!BootstrappedManifest.KIND_DATA.equals(def.getKind())) continue;
            if ("secret".equals(entry.getNamespace())) {
                if (!options.isIncludeSecrets()) continue;
            } else if (!def.isShareable() || def.isSensitive()) {
                continue;
            }

            Object[] result = readInternal(logicalKey, new HashSet<>());
            boolean found = (Boolean) result[1];
            if (!found || result[0] == null) continue;
            output.put(envVar, JsCompat.jsStringifyValue(result[0]));
        }
        return output;
    }

    /**
     * Returns public env entries, with optional framework prefix applied.
     */
    public Map<String, String> toPublicEnv(ToPublicEnvOptions options) throws CnosError {
        if (options == null) options = new ToPublicEnvOptions();
        String prefix = resolvePublicPrefix(options);
        Map<String, String> output = new LinkedHashMap<>();

        List<String> keys = entries.keySet().stream()
                .filter(k -> {
                    RuntimeEntry e = entries.get(k);
                    return e != null && "public".equals(e.getNamespace());
                })
                .sorted()
                .collect(Collectors.toList());

        for (String key : keys) {
            // Check if source is runtime-dependent (cannot be in public env)
            String sourceKey = resolveProjectedSourceKey(key);
            if (sourceKey.startsWith("secret.")) continue;
            RuntimeEntry source = entries.get(sourceKey);
            if (source != null && source.getFormula() != null && source.getFormula().isRuntimeDependent()) {
                Object[] r = readInternal(key, new HashSet<>());
                if (!(Boolean) r[1] || r[0] == null) {
                    throw new CnosError("cnos: cannot build public output for " + key
                            + " because it depends on runtime-only values");
                }
            }

            Object[] result = readInternal(key, new HashSet<>());
            boolean found = (Boolean) result[1];
            if (!found || result[0] == null) continue;

            String subPath = key.startsWith("public.") ? key.substring(7) : key;
            String baseEnvVar = fallbackPublicEnvVar(subPath);
            String envVar = baseEnvVar;
            if (prefix != null && !prefix.isEmpty() && !baseEnvVar.startsWith(prefix)) {
                envVar = prefix + baseEnvVar;
            }
            output.put(envVar, JsCompat.jsStringifyValue(result[0]));
        }
        return output;
    }

    /**
     * Inspects a config key, returning detailed provenance and derivation info.
     *
     * @throws CnosError if the key is not found or inspection fails
     */
    public InspectResult inspect(String key) throws CnosError {
        RuntimeEntry entry = entries.get(key);
        if (entry == null) throw new CnosError(CnosError.MISSING_KEY + ": " + key);

        Object[] result = readInternal(key, new HashSet<>());
        Object value = result[0];

        InspectResult.InspectWorkspace ws = new InspectResult.InspectWorkspace(
                firstNonEmpty(workspaceState.id, profileWorkspace("workspace")),
                firstNonEmpty(workspaceState.source, "implicit"),
                inspectWorkspaceChain());

        RuntimeProvenance winner = entry.getWinner();
        InspectResult.InspectWinner inspectWinner = new InspectResult.InspectWinner(
                firstNonEmpty(winner != null ? winner.getSourceId() : null, sources.get(key)),
                firstNonEmpty(winner != null ? winner.getPluginId() : null, "cnos"),
                firstNonEmpty(winner != null ? winner.getWorkspaceId() : null, profileWorkspace("workspace")),
                winner != null ? cloneOrigin(winner.getOrigin()) : null);

        List<InspectResult.InspectOverride> overrides = new ArrayList<>();
        for (RuntimeProvenance prov : entry.getOverridden()) {
            overrides.add(new InspectResult.InspectOverride(
                    prov.getSourceId(),
                    firstNonEmpty(prov.getPluginId(), prov.getSourceId()),
                    prov.getWorkspaceId(),
                    prov.getValue(),
                    cloneOrigin(prov.getOrigin())));
        }

        InspectResult.InspectDerived derived = null;
        if (entry.getFormula() != null) {
            derived = buildInspectDerived(key, entry);
        }

        return new InspectResult(key, value, entry.getNamespace(),
                profileWorkspace("profile"),
                firstNonEmpty(profileSource, "manifest-default"),
                ws, inspectWinner, overrides, derived);
    }

    /**
     * Formats a message string by substituting {@code ${key}} patterns with resolved values.
     */
    public String format(String message) throws CnosError {
        CnosError[] err = {null};
        String result = TEMPLATE_PATTERN.matcher(message).replaceAll(mr -> {
            if (err[0] != null) return Matcher.quoteReplacement(mr.group(0));
            String key = mr.group(1).trim();
            if (key.isEmpty()) return Matcher.quoteReplacement(mr.group(0));
            try {
                Object[] r = readInternal(key, new HashSet<>());
                boolean found = (Boolean) r[1];
                if (!found) return Matcher.quoteReplacement(mr.group(0));
                return Matcher.quoteReplacement(JsCompat.jsLogStringifyValue(r[0]));
            } catch (CnosError e) {
                err[0] = e;
                return Matcher.quoteReplacement(mr.group(0));
            }
        });
        if (err[0] != null) throw err[0];
        return result;
    }

    /**
     * Registers a runtime namespace value provider (e.g., for {@code request.*} or {@code session.*}).
     *
     * @throws CnosError if the namespace is undeclared or is the built-in {@code process} namespace
     */
    public void registerRuntimeProvider(String namespace,
            java.util.function.Function<String, Object> provider) throws CnosError {
        if ("process".equals(namespace)) {
            throw new CnosError("cnos: cannot override built-in runtime namespace \"process\"");
        }
        if (!runtimeNamespaces.contains(namespace)) {
            throw new CnosError("cnos: cannot register runtime provider for undeclared namespace \"" + namespace + "\"");
        }
        runtimeProviders.put(namespace, provider);
    }

    /** Registers additional vault provider factories on this runtime. */
    public void registerSecretVaultProviders(SecretVaultProviderFactory... factories) {
        for (SecretVaultProviderFactory factory : factories) {
            if (factory != null && !factory.getProvider().isEmpty()) {
                secretFactories.put(factory.getProvider(), factory);
            }
        }
    }

    /**
     * Clears all hydrated secret caches and re-warms every secret in the projection.
     * Mirrors Go's {@code RefreshSecrets()}.
     */
    public void refreshSecrets() throws CnosError {
        // Snapshot both caches before clearing; restore on failure (clone-and-swap parity with Go)
        Map<String, Object> savedHydrated = new HashMap<>(hydratedSecrets);
        Map<String, Map<String, String>> savedLocalCache = new HashMap<>(localVaultCache);
        hydratedSecrets.clear();
        localVaultCache.clear();
        try {
            warmSecrets();
        } catch (CnosError e) {
            hydratedSecrets.clear();
            hydratedSecrets.putAll(savedHydrated);
            localVaultCache.clear();
            localVaultCache.putAll(savedLocalCache);
            throw e;
        }
    }

    /**
     * Evicts and re-hydrates a single secret by its sub-path or full logical key.
     * Mirrors Go's {@code RefreshSecret(path)}.
     *
     * @param path sub-path like {@code db.password} or full key like {@code secret.db.password}
     */
    public void refreshSecret(String path) throws CnosError {
        String key = toLogicalKey("secret", path);
        RuntimeEntry entry = entries.get(key);
        if (entry == null || entry.getSecretRef() == null) return;

        // Snapshot current state for rollback
        boolean hadValue = hydratedSecrets.containsKey(key);
        Object savedValue = hydratedSecrets.get(key);
        String vaultId = logicalKeyToVault.get(key);
        Map<String, String> savedVaultCache = null;
        if (vaultId != null && localVaultCache.containsKey(vaultId)) {
            savedVaultCache = new HashMap<>(localVaultCache.get(vaultId));
        }

        hydratedSecrets.remove(key);
        if (vaultId != null) localVaultCache.remove(vaultId);

        try {
            readSecret(key, entry.getSecretRef());
        } catch (CnosError e) {
            if (hadValue) hydratedSecrets.put(key, savedValue);
            if (vaultId != null) {
                if (savedVaultCache != null) localVaultCache.put(vaultId, savedVaultCache);
                else localVaultCache.remove(vaultId);
            }
            throw e;
        }
    }

    // ================================================================
    // Internal implementation
    // ================================================================

    /** Returns [value, found(Boolean)] */
    Object[] readInternal(String key, Set<String> stack) throws CnosError {
        RuntimeEntry entry = entries.get(key);
        if (entry == null) {
            // Check runtime namespace providers
            int dot = key.indexOf('.');
            if (dot > 0) {
                String namespace = key.substring(0, dot);
                String rest = key.substring(dot + 1);
                java.util.function.Function<String, Object> provider = runtimeProviders.get(namespace);
                if (provider != null) {
                    return new Object[]{provider.apply(rest), Boolean.TRUE};
                }
            }
            return new Object[]{null, Boolean.FALSE};
        }

        if (entry.getAliasTo() != null && !entry.getAliasTo().isEmpty()) {
            return readInternal(entry.getAliasTo(), stack);
        }

        if (entry.getSecretRef() != null) {
            return readSecret(entry.getKey(), entry.getSecretRef());
        }

        if (entry.getFormula() != null) {
            if (stack.contains(key)) {
                throw new CnosError("cnos: unable to resolve derived config key " + key
                        + " because of a recursive dependency on " + key);
            }
            if (!entry.getFormula().isRuntimeDependent() && entry.isFormulaCached()) {
                return new Object[]{entry.getFormulaCache(), Boolean.TRUE};
            }
            Set<String> next = new HashSet<>(stack);
            next.add(key);
            Object value = FormulaEvaluator.evaluate(key, entry.getFormula(), ref -> {
                Object[] r = readInternal(ref, next);
                return r;
            });
            if (!entry.getFormula().isRuntimeDependent()) {
                entry.setFormulaCache(value);
            }
            return new Object[]{value, Boolean.TRUE};
        }

        return new Object[]{entry.getValue(), Boolean.TRUE};
    }

    private void warmSecrets() throws CnosError {
        List<String> keys = new ArrayList<>();
        for (Map.Entry<String, RuntimeEntry> e : entries.entrySet()) {
            if (e.getValue().getSecretRef() != null) keys.add(e.getKey());
        }
        Collections.sort(keys);
        for (String key : keys) {
            RuntimeEntry entry = entries.get(key);
            if (entry == null || entry.getSecretRef() == null) continue;
            readSecret(key, entry.getSecretRef());
        }
    }

    private Object[] readSecret(String key, SecretReference ref) throws CnosError {
        validateSecretRefVaultProvider(key, ref);

        if (encryptedSecrets != null && encryptedSecrets.containsKey(key)) {
            return new Object[]{encryptedSecrets.get(key), Boolean.TRUE};
        }
        if (hydratedSecrets.containsKey(key)) {
            return new Object[]{hydratedSecrets.get(key), Boolean.TRUE};
        }

        List<VaultDefinition> definitions = secretVaultDefinitions(ref);
        CnosError lastError = null;
        for (VaultDefinition definition : definitions) {
            try {
                Object[] result = readSecretWithDefinition(key, ref, definition);
                if (result != null) {
                    Object value = result[0];
                    if (value != null) {
                        hydratedSecrets.put(key, value);
                        return new Object[]{value, Boolean.TRUE};
                    }
                }
            } catch (CnosError e) {
                lastError = e;
            }
        }

        if (lastError != null) throw lastError;
        hydratedSecrets.put(key, null);
        return new Object[]{null, Boolean.TRUE};
    }

    private Object[] readSecretWithDefinition(String key, SecretReference ref,
            VaultDefinition definition) throws CnosError {
        String provider = definition.getProvider();
        switch (provider) {
            case "environment":
            case "github-secrets":
                return new Object[]{readEnvironmentSecretWithDefinition(ref, definition), Boolean.TRUE};
            case "local": {
                Map<String, String> secrets = localVaultSecrets(ref.getVault());
                String value = secrets.get(ref.getRef());
                return new Object[]{value, Boolean.TRUE};
            }
            default: {
                if (!secretFactories.containsKey(provider)) {
                    throw new CnosError("cnos: unsupported vault provider: " + provider);
                }
                Map<String, String> refsByKey = refsForVaultCandidate(ref.getVault(), definition);
                hydrateCustomVault(ref.getVault(), definition, refsByKey);
                return new Object[]{hydratedSecrets.get(key), Boolean.TRUE};
            }
        }
    }

    private List<VaultDefinition> secretVaultDefinitions(SecretReference ref) {
        VaultDefinition def = secretVaultDefinition(ref);
        List<VaultDefinition> result = new ArrayList<>();
        result.add(def);
        result.addAll(def.getFallback());
        return result;
    }

    private VaultDefinition secretVaultDefinition(SecretReference ref) {
        VaultDefinition def = vaults.get(ref.getVault());
        if (def != null) {
            if (def.getProvider() == null || def.getProvider().isEmpty()) {
                def = def.withProvider(ref.getProvider());
            }
            return def;
        }
        String provider = ref.getProvider();
        if (provider == null || provider.isEmpty()) provider = "local";
        String method = VaultResolver.defaultVaultMethod(provider);
        return new VaultDefinition(
                provider,
                new VaultDefinition.Auth(method, null, null, null),
                Collections.emptyMap(),
                Collections.emptyList());
    }

    private void validateSecretRefVaultProvider(String key, SecretReference ref) throws CnosError {
        if (ref.getVault() == null || ref.getVault().isEmpty()
                || ref.getProvider() == null || ref.getProvider().isEmpty()) return;
        VaultDefinition def = vaults.get(ref.getVault());
        if (def == null || def.getProvider() == null || def.getProvider().isEmpty()
                || def.getProvider().equals(ref.getProvider())) return;
        throw new CnosError("cnos: secret ref \"" + key + "\" declares provider \"" + ref.getProvider()
                + "\" but vault \"" + ref.getVault() + "\" uses provider \"" + def.getProvider() + "\"");
    }

    private Map<String, String> refsForVaultCandidate(String vaultId, VaultDefinition definition) {
        Map<String, String> refsByKey = new LinkedHashMap<>();
        List<String> keys = new ArrayList<>(entries.keySet());
        Collections.sort(keys);
        for (String key : keys) {
            RuntimeEntry entry = entries.get(key);
            if (entry == null || entry.getSecretRef() == null
                    || !vaultId.equals(entry.getSecretRef().getVault())) continue;
            if (hydratedSecrets.containsKey(key)) continue;
            for (VaultDefinition candidate : secretVaultDefinitions(entry.getSecretRef())) {
                if (candidate.getProvider().equals(definition.getProvider())) {
                    refsByKey.put(key, entry.getSecretRef().getRef());
                    break;
                }
            }
        }
        return refsByKey;
    }

    private void hydrateCustomVault(String vaultId, VaultDefinition definition,
            Map<String, String> refsByKey) throws CnosError {
        SecretVaultProviderFactory factory = secretFactories.get(definition.getProvider());
        if (factory == null) {
            throw new CnosError("cnos: unsupported vault provider: " + definition.getProvider());
        }

        Set<String> seen = new HashSet<>();
        List<String> refs = new ArrayList<>();
        for (String ref : refsByKey.values()) {
            if (seen.add(ref)) refs.add(ref);
        }
        Collections.sort(refs);

        SecretVaultProvider provider = factory.create(vaultId, definition);
        if (provider == null) {
            throw new CnosError("cnos: create vault provider \"" + definition.getProvider()
                    + "\" for vault \"" + vaultId + "\" returned null");
        }

        VaultAuthConfig auth = VaultResolver.resolveVaultAuth(vaultId, definition, env);
        provider.authenticate(auth);

        Map<String, Object> values = provider.batchGet(refs);
        for (Map.Entry<String, String> e : refsByKey.entrySet()) {
            String key = e.getKey();
            String ref = e.getValue();
            if (hydratedSecrets.containsKey(key)) continue;
            Object value = values.get(ref);
            if (value != null) {
                hydratedSecrets.put(key, value);
            }
        }
    }

    private Object readEnvironmentSecretWithDefinition(SecretReference ref, VaultDefinition definition) {
        Optional<String> v = env.get(ref.getRef());
        if (v.isPresent()) return v.get();
        if (ref.getEnvVar() != null && !ref.getEnvVar().isEmpty()) {
            v = env.get(ref.getEnvVar());
            if (v.isPresent()) return v.get();
        }
        // Check definition mapping
        if (definition != null) {
            for (Map.Entry<String, String> e : definition.getMapping().entrySet()) {
                if (e.getValue().equals(ref.getRef())) {
                    v = env.get(e.getKey());
                    if (v.isPresent()) return v.get();
                    break;
                }
            }
        }
        return null;
    }

    private Map<String, String> localVaultSecrets(String vaultId) throws CnosError {
        Map<String, String> cached = localVaultCache.get(vaultId);
        if (cached != null) return cached;

        VaultDefinition definition = vaults.get(vaultId);
        File metaFile = new File(secretHome, "vaults/" + vaultId + "/meta.yml");
        if (!metaFile.exists()) {
            throw new CnosError("cnos: missing CNOS vault metadata for \"" + vaultId + "\"");
        }
        byte[] metaBytes;
        try {
            metaBytes = Files.readAllBytes(metaFile.toPath());
        } catch (IOException e) {
            throw new CnosError("cnos: missing CNOS vault metadata for \"" + vaultId + "\"", e);
        }

        LocalVault.Metadata meta = LocalVault.parseMetadata(metaBytes);
        byte[] key = VaultResolver.resolveLocalVaultKey(secretHome, vaultId, meta, definition, env);
        Map<String, String> secrets = LocalVault.readVaultSecrets(secretHome, vaultId, key);
        localVaultCache.put(vaultId, secrets);
        return secrets;
    }

    private Map<String, Object> toNamespaceObject(String namespace) throws CnosError {
        Map<String, Object> output = new LinkedHashMap<>();
        List<String> keys = new ArrayList<>(entries.keySet());
        Collections.sort(keys);

        for (String key : keys) {
            RuntimeEntry entry = entries.get(key);
            if (entry == null) continue;
            if (!namespace.isEmpty() && !namespace.equals(entry.getNamespace())) continue;

            Object[] result = readInternal(key, new HashSet<>());
            boolean found = (Boolean) result[1];
            if (!found) continue;

            String targetPath = namespace.isEmpty() ? key : key.substring(namespace.length() + 1);
            setNestedValue(output, targetPath.split("\\."), result[0]);
        }
        return output;
    }

    private String resolvePublicPrefix(ToPublicEnvOptions options) throws CnosError {
        if (options.getPrefix() != null && !options.getPrefix().isEmpty()) return options.getPrefix();
        if (options.getFramework() == null || options.getFramework().isEmpty()) return "";
        String prefix = manifest.getFrameworks().get(options.getFramework());
        if (prefix == null) {
            throw new CnosError("cnos: unknown public framework prefix: " + options.getFramework());
        }
        return prefix;
    }

    private String resolveProjectedSourceKey(String key) {
        RuntimeEntry entry = entries.get(key);
        if (entry != null) {
            if (entry.getAliasTo() != null && !entry.getAliasTo().isEmpty()) return entry.getAliasTo();
            if (entry.getPromotedFrom() != null && !entry.getPromotedFrom().isEmpty()) return entry.getPromotedFrom();
        }
        if (key.startsWith("public.")) {
            String fallback = "value." + key.substring(7);
            if (entries.containsKey(fallback)) return fallback;
        }
        return key;
    }

    private InspectResult.InspectDerived buildInspectDerived(String key, RuntimeEntry entry) throws CnosError {
        ParsedFormula formula = entry.getFormula();
        List<InspectResult.InspectDependency> deps = new ArrayList<>();
        for (String ref : formula.getRefs()) {
            Object[] r = readInternal(ref, new HashSet<>());
            boolean found = (Boolean) r[1];
            Object value = found ? r[0] : null;
            String namespace = namespaceForKey(ref);
            String runtimeNs = runtimeNamespaces.contains(namespace) ? namespace : null;
            deps.add(new InspectResult.InspectDependency(ref, value, runtimeNs));
        }

        List<String> runtimeNsList = new ArrayList<>();
        for (String ref : formula.getRuntimeRefs()) {
            String ns = namespaceForKey(ref);
            if (ns != null && !ns.isEmpty()) runtimeNsList.add(ns);
        }
        runtimeNsList = FormulaParser.uniqueSorted(runtimeNsList);

        String promotionWarning = formula.isRuntimeDependent()
                ? "Cannot be promoted to browser/public." : null;

        return new InspectResult.InspectDerived(
                formula.isTemplate() ? "template" : "expression",
                formula.getRaw(),
                deps,
                formula.isRuntimeDependent(),
                runtimeNsList,
                promotionWarning);
    }

    String profileWorkspace(String kind) {
        if ("workspace".equals(kind)) {
            try {
                Object[] r = readInternal("meta.workspace", new HashSet<>());
                if ((Boolean) r[1] && r[0] instanceof String) return (String) r[0];
            } catch (CnosError ignored) {}
        } else if ("profile".equals(kind)) {
            try {
                Object[] r = readInternal("meta.profile", new HashSet<>());
                if ((Boolean) r[1] && r[0] instanceof String) return (String) r[0];
            } catch (CnosError ignored) {}
        }
        return "";
    }

    private List<String> inspectWorkspaceChain() {
        if (workspaceState.chain != null && !workspaceState.chain.isEmpty()) {
            return new ArrayList<>(workspaceState.chain);
        }
        String workspace = profileWorkspace("workspace");
        if (workspace.isEmpty()) return Collections.emptyList();
        return Collections.singletonList(workspace);
    }

    // ================================================================
    // Runtime construction helpers
    // ================================================================

    private static CnosRuntime newRuntime(byte[] source, Environment env, String secretHome,
            List<SecretVaultProviderFactory> factories) throws CnosError {
        ServerProjection projection = ServerProjection.parse(source);
        Map<String, Object> encryptedSecrets = decryptSecretPayloadFromEnv(env);
        BootstrappedManifest manifest = bootstrappedManifestFromProjection(projection);

        Map<String, String> parsedArgs0 = parseCliArgs(getProcessArgs());
        Builder b = new Builder()
                .projection(projection)
                .manifest(manifest)
                .profileSource("manifest-default")
                .workspaceState(newImplicitWorkspaceState(projection.getWorkspace()))
                .graphBootstrapped(false)
                .env(env)
                .secretHome(secretHome)
                .encryptedSecrets(encryptedSecrets)
                .factories(factories)
                .parsedArgs(parsedArgs0)
                .fileOverrides(loadPatchFile(detectPatchPath(parsedArgs0, env)));

        CnosRuntime runtime = b.build();
        runtime.populateEntries();
        runtime.initializeRuntimeProviders(projection.getRuntimeNamespaces());
        runtime.prepareDerivedEntries();
        return runtime;
    }

    private static CnosRuntime newRuntimeFromGraph(byte[] source, Environment env, String secretHome,
            List<SecretVaultProviderFactory> factories) throws CnosError {
        RuntimeGraph graph = RuntimeGraph.parse(source);
        Map<String, Object> encryptedSecrets = decryptSecretPayloadFromEnv(env);
        BootstrappedManifest manifest = bootstrappedManifestFromGraph(graph);

        WorkspaceState ws = new WorkspaceState(
                graph.getWorkspace().getWorkspaceId(),
                graph.getWorkspace().getWorkspaceSource(),
                new ArrayList<>(graph.getWorkspace().getWorkspaceChain()));

        Map<String, String> parsedArgs1 = parseCliArgs(getProcessArgs());
        Builder b = new Builder()
                .projection(null)
                .manifest(manifest)
                .profileSource(graph.getProfileSource())
                .workspaceState(ws)
                .graphBootstrapped(true)
                .env(env)
                .secretHome(secretHome)
                .encryptedSecrets(encryptedSecrets)
                .factories(factories)
                .parsedArgs(parsedArgs1)
                .fileOverrides(loadPatchFile(detectPatchPath(parsedArgs1, env)));

        CnosRuntime runtime = b.build();

        for (RuntimeGraph.ResolvedEntry resolved : graph.getEntries()) {
            RuntimeEntry entry = runtimeEntryFromGraph(resolved);
            runtime.entries.put(resolved.getKey(), entry);
            runtime.sources.put(resolved.getKey(), resolved.getWinner().getSourceId());
            if (entry.getSecretRef() != null) {
                String vault = entry.getSecretRef().getVault();
                if (vault != null && !vault.isEmpty()) {
                    runtime.logicalKeyToVault.put(resolved.getKey(), vault);
                }
            }
        }

        List<String> runtimeNs = new ArrayList<>(manifest.getNamespaces().keySet());
        // Remove config namespaces, keep only runtime ones registered in the manifest
        // Actually we use the keys from runtimeNamespaceDefinition map; bootstrap adds "process" plus any discovered ones
        // We track this by checking which namespaces were added as runtime in bootstrappedManifestFromGraph
        // For simplicity, pass all namespace keys to initializeRuntimeProviders; it will filter
        runtimeNs = sortedRuntimeNamespaces(graph);
        runtime.initializeRuntimeProviders(runtimeNs);
        runtime.prepareDerivedEntries();
        return runtime;
    }

    private void populateEntries() {
        Set<String> explicitNamespaces = new HashSet<>(
                Arrays.asList("config", "flags", "process"));
        if (projection.getMeta().getNamespaces() != null) {
            explicitNamespaces.addAll(projection.getMeta().getNamespaces());
        }

        RuntimeProvenance serverProv = new RuntimeProvenance(
                "server-projection", "cnos", projection.getWorkspace());

        for (Map.Entry<String, Object> e : projection.getValues().entrySet()) {
            String logicalKey = projectionLogicalKey(e.getKey(), explicitNamespaces);
            entries.put(logicalKey, new RuntimeEntry.Builder()
                    .key(logicalKey)
                    .namespace(namespaceForKey(logicalKey))
                    .value(e.getValue())
                    .winner(serverProv)
                    .build());
            sources.put(logicalKey, "server-projection");
        }

        for (Map.Entry<String, DerivedFormula> e : projection.getDerived().entrySet()) {
            String logicalKey = projectionLogicalKey(e.getKey(), explicitNamespaces);
            ParsedFormula parsed;
            try {
                parsed = FormulaParser.parseDerivedFormula(e.getValue());
            } catch (CnosError ex) {
                throw new RuntimeException("cnos: parse derived formula for " + logicalKey + ": " + ex.getMessage(), ex);
            }
            entries.put(logicalKey, new RuntimeEntry.Builder()
                    .key(logicalKey)
                    .namespace(namespaceForKey(logicalKey))
                    .formula(parsed)
                    .winner(serverProv)
                    .build());
            sources.put(logicalKey, "server-projection");
        }

        for (Map.Entry<String, SecretReference> e : projection.getSecretRefs().entrySet()) {
            String logicalKey = toLogicalKey("secret", e.getKey());
            SecretReference ref = e.getValue();
            if (ref.getVault() == null || ref.getVault().isEmpty()) ref = ref.withVault("default");
            entries.put(logicalKey, new RuntimeEntry.Builder()
                    .key(logicalKey)
                    .namespace("secret")
                    .secretRef(ref)
                    .winner(serverProv)
                    .build());
            sources.put(logicalKey, "server-projection");
            logicalKeyToVault.put(logicalKey, ref.getVault());
        }

        for (String key : projection.getPublicKeys()) {
            String sourceKey = key;
            if (!entries.containsKey(sourceKey)) {
                sourceKey = toLogicalKey("value", key);
            }
            if (!entries.containsKey(sourceKey)) continue;
            if (sourceKey.startsWith("secret.")) continue;

            String publicKey = toLogicalKey("public", key);
            entries.put(publicKey, new RuntimeEntry.Builder()
                    .key(publicKey)
                    .namespace("public")
                    .aliasTo(sourceKey)
                    .promotedFrom(sourceKey)
                    .winner(serverProv)
                    .build());
            sources.put(publicKey, "server-projection");
        }

        // Meta entries
        entries.put("meta.profile", new RuntimeEntry.Builder()
                .key("meta.profile").namespace("meta")
                .value(projection.getProfile()).winner(serverProv).build());
        entries.put("meta.workspace", new RuntimeEntry.Builder()
                .key("meta.workspace").namespace("meta")
                .value(projection.getWorkspace()).winner(serverProv).build());
        entries.put("meta.cnos_version", new RuntimeEntry.Builder()
                .key("meta.cnos_version").namespace("meta")
                .value(projection.getMeta().getCnosVersion()).winner(serverProv).build());
        sources.put("meta.profile", "server-projection");
        sources.put("meta.workspace", "server-projection");
        sources.put("meta.cnos_version", "server-projection");
    }

    private void initializeRuntimeProviders(List<String> namespaces) {
        for (String ns : namespaces) {
            runtimeNamespaces.add(ns);
        }
        if (runtimeNamespaces.contains("process")) {
            runtimeProviders.put("process", processProvider());
        }
    }

    private java.util.function.Function<String, Object> processProvider() {
        return path -> {
            if (path.startsWith("env.")) {
                String varName = path.substring(4);
                Optional<String> v = env.get(varName);
                return v.orElse(null);
            }
            switch (path) {
                case "cwd":
                    try { return new File(".").getCanonicalPath(); } catch (IOException e) { return null; }
                case "platform": return JsCompat.nodePlatform();
                case "arch": return JsCompat.nodeArch();
                case "pid": return (long) ProcessHandle.current().pid();
                default: return null;
            }
        };
    }

    private void prepareDerivedEntries() throws CnosError {
        List<String> keys = entries.keySet().stream()
                .filter(k -> entries.get(k) != null && entries.get(k).getFormula() != null)
                .sorted()
                .collect(Collectors.toList());

        Set<String> resolved = new HashSet<>();
        Set<String> visiting = new HashSet<>();

        for (String key : keys) {
            visitDerived(key, resolved, visiting);
        }
    }

    private void visitDerived(String key, Set<String> resolved, Set<String> visiting) throws CnosError {
        if (resolved.contains(key)) return;
        if (visiting.contains(key)) {
            throw new CnosError("cnos: unable to resolve derived config key " + key
                    + " because of a recursive dependency on " + key);
        }

        RuntimeEntry entry = entries.get(key);
        if (entry == null || entry.getFormula() == null) {
            resolved.add(key);
            return;
        }

        visiting.add(key);
        ParsedFormula formula = entry.getFormula();
        List<String> runtimeRefs = new ArrayList<>(formula.getRuntimeRefs());
        boolean runtimeDependent = formula.isRuntimeDependent();

        for (String ref : formula.getRefs()) {
            String ns = namespaceForKey(ref);
            if (ns == null || ns.isEmpty()) continue;

            if (runtimeNamespaces.contains(ns)) {
                runtimeDependent = true;
                if (!runtimeRefs.contains(ref)) runtimeRefs.add(ref);
                continue;
            }

            RuntimeEntry dep = entries.get(ref);
            if (dep != null && dep.getFormula() != null) {
                visitDerived(ref, resolved, visiting);
                if (dep.getFormula().isRuntimeDependent()) {
                    runtimeDependent = true;
                }
            }
        }

        formula.setRuntimeRefs(FormulaParser.uniqueSorted(runtimeRefs));
        formula.setRuntimeDependent(runtimeDependent);
        formula.setDeps(filterFormulaDeps(formula.getRefs(), runtimeNamespaces));
        visiting.remove(key);
        resolved.add(key);
    }

    // ================================================================
    // Bootstrap helpers
    // ================================================================

    private static BootstrappedManifest bootstrappedManifestFromProjection(ServerProjection projection) {
        Map<String, BootstrappedManifest.NamespaceDef> namespaces =
                new HashMap<>(BootstrappedManifest.DEFAULT_NAMESPACES);
        if (projection.getMeta().getNamespaces() != null) {
            for (String ns : projection.getMeta().getNamespaces()) {
                namespaces.computeIfAbsent(ns, k ->
                        new BootstrappedManifest.NamespaceDef(BootstrappedManifest.KIND_DATA, false, false, false, null));
            }
        }
        return new BootstrappedManifest(namespaces,
                new HashMap<>(BootstrappedManifest.DEFAULT_FRAMEWORKS),
                Collections.emptyMap(),
                projection.getVaults());
    }

    private static BootstrappedManifest bootstrappedManifestFromGraph(RuntimeGraph graph) {
        Map<String, BootstrappedManifest.NamespaceDef> namespaces =
                new HashMap<>(BootstrappedManifest.DEFAULT_NAMESPACES);
        return new BootstrappedManifest(namespaces,
                new HashMap<>(BootstrappedManifest.DEFAULT_FRAMEWORKS),
                Collections.emptyMap(),
                Collections.emptyMap());
    }

    private static List<String> sortedRuntimeNamespaces(RuntimeGraph graph) {
        // Discover runtime namespaces from graph entries (namespaces used in derived formulas
        // that are not in the set of config namespaces)
        Set<String> configNs = new HashSet<>(Arrays.asList("value", "secret", "meta", "public"));
        for (RuntimeGraph.ResolvedEntry e : graph.getEntries()) {
            configNs.add(e.getNamespace());
        }

        Set<String> runtimeNs = new LinkedHashSet<>();
        runtimeNs.add("process"); // always included
        for (RuntimeGraph.ResolvedEntry e : graph.getEntries()) {
            if (!FormulaParser.isDerivedValue(e.getValue())) continue;
            try {
                ParsedFormula pf = FormulaParser.parseRawDerivedValue(e.getValue());
                for (String ref : pf.getRefs()) {
                    String ns = namespaceForKey(ref);
                    if (ns != null && !configNs.contains(ns)) {
                        runtimeNs.add(ns);
                    }
                }
            } catch (CnosError ignored) {}
        }

        List<String> sorted = new ArrayList<>(runtimeNs);
        Collections.sort(sorted);
        return sorted;
    }

    private static RuntimeEntry runtimeEntryFromGraph(RuntimeGraph.ResolvedEntry resolved) throws CnosError {
        RuntimeGraph.ConfigEntry winner = resolved.getWinner();
        RuntimeProvenance prov = new RuntimeProvenance(
                winner.getSourceId(), winner.getPluginId(), winner.getWorkspaceId(),
                null, winner.getOrigin());

        List<RuntimeProvenance> overridden = new ArrayList<>();
        for (RuntimeGraph.ConfigEntry o : resolved.getOverridden()) {
            overridden.add(new RuntimeProvenance(o.getSourceId(), o.getPluginId(), o.getWorkspaceId(),
                    o.getValue(), o.getOrigin()));
        }

        String promotedFrom = null;
        Map<String, Object> meta = resolved.getWinner().getMetadata();
        if (meta != null && meta.get("promotedFrom") instanceof String) {
            promotedFrom = (String) meta.get("promotedFrom");
        }

        RuntimeEntry.Builder b = new RuntimeEntry.Builder()
                .key(resolved.getKey())
                .namespace(resolved.getNamespace())
                .promotedFrom(promotedFrom)
                .winner(prov)
                .overridden(overridden);

        if ("secret".equals(resolved.getNamespace()) && isSecretReferenceValue(resolved.getValue())) {
            SecretReference ref = toSecretReference(resolved.getValue());
            if (ref.getVault() == null || ref.getVault().isEmpty()) ref = ref.withVault("default");
            return b.secretRef(ref).build();
        }

        if (FormulaParser.isDerivedValue(resolved.getValue())) {
            ParsedFormula formula = FormulaParser.parseRawDerivedValue(resolved.getValue());
            return b.formula(formula).build();
        }

        return b.value(resolved.getValue()).build();
    }

    static boolean isSecretReferenceValue(Object value) {
        if (!(value instanceof Map)) return false;
        @SuppressWarnings("unchecked")
        Map<String, Object> doc = (Map<String, Object>) value;
        Object refObj = doc.get("ref");
        if (!(refObj instanceof String) || ((String) refObj).trim().isEmpty()) return false;
        Object providerObj = doc.get("provider");
        if (providerObj instanceof String && ((String) providerObj).trim().isEmpty()) return false;
        for (String key : doc.keySet()) {
            if (!"provider".equals(key) && !"ref".equals(key) && !"vault".equals(key)) return false;
        }
        return true;
    }

    static SecretReference toSecretReference(Object value) throws CnosError {
        if (!(value instanceof Map)) throw new CnosError("cnos: invalid secret reference");
        @SuppressWarnings("unchecked")
        Map<String, Object> doc = (Map<String, Object>) value;
        String provider = doc.get("provider") instanceof String ? (String) doc.get("provider") : "";
        String ref = doc.get("ref") instanceof String ? (String) doc.get("ref") : "";
        String vault = doc.get("vault") instanceof String ? (String) doc.get("vault") : "";
        if (ref.trim().isEmpty()) throw new CnosError("cnos: invalid secret reference");
        return new SecretReference(provider.trim(), ref.trim(), vault.trim(), null);
    }

    private static Map<String, Object> decryptSecretPayloadFromEnv(Environment env) throws CnosError {
        Optional<String> payloadOpt = env.get(SECRET_PAYLOAD_ENV_VAR);
        if (!payloadOpt.isPresent() || payloadOpt.get().isEmpty()) return null;
        Optional<String> keyOpt = env.get(SESSION_KEY_ENV_VAR);
        if (!keyOpt.isPresent() || keyOpt.get().isEmpty()) return null;

        byte[] plaintext = LocalVault.decryptSessionPayload(keyOpt.get(), payloadOpt.get());
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> result = MAPPER.readValue(plaintext, Map.class);
            return result;
        } catch (IOException e) {
            throw new CnosError("cnos: decode encrypted secret payload: " + e.getMessage(), e);
        }
    }

    // ================================================================
    // String/key helpers
    // ================================================================

    static String namespaceForKey(String key) {
        int dot = key != null ? key.indexOf('.') : -1;
        return dot > 0 ? key.substring(0, dot) : null;
    }

    static String toLogicalKey(String namespace, String valuePath) {
        if (valuePath == null || valuePath.trim().isEmpty()) return namespace + ".";
        // Idempotency guard: already-prefixed key passed in (e.g. "secret.db.password" to secret())
        String trimmedPath = valuePath.trim();
        if (trimmedPath.startsWith(namespace + ".")) return trimmedPath;
        StringBuilder sb = new StringBuilder(namespace).append('.');
        boolean first = true;
        for (String part : trimmedPath.split("\\.")) {
            part = part.trim();
            if (!part.isEmpty()) {
                if (!first) sb.append('.');
                sb.append(part);
                first = false;
            }
        }
        return sb.toString();
    }

    private static String projectionLogicalKey(String raw, Set<String> explicitNamespaces) {
        if (raw.startsWith("value.") || raw.startsWith("public.")) return raw;
        String first = raw.contains(".") ? raw.substring(0, raw.indexOf('.')) : raw;
        if (explicitNamespaces.contains(first)) return raw;
        return toLogicalKey("value", raw);
    }

    private static String fallbackPublicEnvVar(String valuePath) {
        StringBuilder sb = new StringBuilder();
        boolean lastUnderscore = false;
        char[] chars = valuePath.toCharArray();
        for (int i = 0; i < chars.length; i++) {
            char c = chars[i];
            if (c >= 'a' && c <= 'z') {
                sb.append((char) (c - 32));
                lastUnderscore = false;
            } else if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
                sb.append(c);
                lastUnderscore = false;
            } else {
                if (!lastUnderscore) { sb.append('_'); lastUnderscore = true; }
            }
        }
        String result = sb.toString();
        // Trim leading/trailing underscores
        int start = 0, end = result.length();
        while (start < end && result.charAt(start) == '_') start++;
        while (end > start && result.charAt(end - 1) == '_') end--;
        return result.substring(start, end);
    }

    private static List<String> filterFormulaDeps(List<String> refs, Set<String> runtimeNamespaces) {
        List<String> deps = new ArrayList<>();
        for (String ref : refs) {
            String ns = namespaceForKey(ref);
            if (ns == null || ns.isEmpty()) continue;
            if (runtimeNamespaces.contains(ns)) continue;
            deps.add(ref);
        }
        return FormulaParser.uniqueSorted(deps);
    }

    private static void setNestedValue(Map<String, Object> target, String[] segments, Object value) {
        if (segments.length == 0 || segments[0].isEmpty()) return;
        if (segments.length == 1) {
            target.put(segments[0], value);
            return;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> child = (Map<String, Object>) target.computeIfAbsent(
                segments[0], k -> new LinkedHashMap<>());
        setNestedValue(child, Arrays.copyOfRange(segments, 1, segments.length), value);
    }

    // ================================================================
    // Projection file discovery
    // ================================================================

    private static String findProjectionPath(String workingDir) {
        File cwd = workingDir != null && !workingDir.isEmpty()
                ? new File(workingDir).getAbsoluteFile()
                : new File(".").getAbsoluteFile();

        File direct = new File(cwd, PROJECTION_FILE_NAME);
        if (direct.isFile()) return direct.getPath();

        File current = cwd;
        for (int depth = 0; depth <= 3; depth++) {
            File rc = new File(current, CNOSRC_FILE_NAME);
            if (rc.isFile()) {
                File proj = new File(current, PROJECTION_FILE_NAME);
                if (proj.isFile()) return proj.getPath();
            }
            File parent = current.getParentFile();
            if (parent == null || parent.equals(current)) break;
            current = parent;
        }
        return null;
    }

    private static String resolveSecretHome(Environment env, String override) throws CnosError {
        if (override != null && !override.trim().isEmpty()) {
            return expandHome(override);
        }
        Optional<String> envHome = env.get("CNOS_SECRET_HOME");
        if (envHome.isPresent() && !envHome.get().trim().isEmpty()) {
            return expandHome(envHome.get().trim());
        }
        return expandHome("~/.cnos/secrets");
    }

    private static String expandHome(String path) {
        if (path.equals("~")) return System.getProperty("user.home", "");
        if (path.startsWith("~/")) return System.getProperty("user.home", "") + "/" + path.substring(2);
        return new File(path).getAbsolutePath();
    }

    private static String resolvePathFromWorkingDir(String workingDir, String target) {
        if (new File(target).isAbsolute()) return target;
        File base = workingDir != null && !workingDir.isEmpty()
                ? new File(workingDir).getAbsoluteFile()
                : new File(".").getAbsoluteFile();
        return new File(base, target).getAbsolutePath();
    }

    private static byte[] readFile(String path) throws CnosError {
        try {
            return Files.readAllBytes(new File(path).toPath());
        } catch (IOException e) {
            throw new CnosError("cnos: read projection file " + path + ": " + e.getMessage(), e);
        }
    }

    static WorkspaceState newImplicitWorkspaceState(String workspace) {
        if (workspace == null || workspace.trim().isEmpty()) {
            return new WorkspaceState(null, "implicit", Collections.emptyList());
        }
        return new WorkspaceState(workspace, "implicit", Collections.singletonList(workspace));
    }

    static ConfigOrigin cloneOrigin(ConfigOrigin origin) {
        if (origin == null) return null;
        return origin.copy();
    }

    static String firstNonEmpty(String... values) {
        for (String v : values) {
            if (v != null && !v.trim().isEmpty()) return v.trim();
        }
        return "";
    }

    // ================================================================
    // Override resolution helpers
    // ================================================================

    private static final List<String> DEFAULT_PRIORITY = java.util.Arrays.asList("arg", "env", "cnos");

    private static String[] getProcessArgs() {
        // Sun/HotSpot: sun.java.command holds class + args; use ManagementFactory for the actual app args
        // The safest portable approach is the RuntimeMXBean input args (JVM flags), but those are JVM args.
        // For application args we rely on a system property set by the caller, or return empty.
        String argsProp = System.getProperty("sun.java.command");
        if (argsProp == null || argsProp.isEmpty()) return new String[0];
        // sun.java.command is "mainClass arg1 arg2 ..." — strip the class name
        String[] parts = argsProp.split("\\s+", -1);
        if (parts.length <= 1) return new String[0];
        String[] result = new String[parts.length - 1];
        System.arraycopy(parts, 1, result, 0, result.length);
        return result;
    }

    private static Map<String, String> parseCliArgs(String[] args) {
        Map<String, String> result = new HashMap<>();
        int i = 0;
        while (i < args.length) {
            String arg = args[i];
            if (!arg.startsWith("-")) { i++; continue; }
            int eq = arg.indexOf('=');
            if (eq >= 0) {
                result.put(arg.substring(0, eq), arg.substring(eq + 1));
                i++;
                continue;
            }
            if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
                result.put(arg, args[i + 1]);
                i += 2;
            } else {
                result.put(arg, "true");
                i++;
            }
        }
        return result;
    }

    private static String detectPatchPath(Map<String, String> parsedArgs, Environment env) {
        String flagVal = parsedArgs.get("--cnos-patch");
        if (flagVal != null && !flagVal.isEmpty()) return flagVal;
        Optional<String> envVal = env.get("CNOS_PATCH_FILE");
        return envVal.isPresent() && !envVal.get().isEmpty() ? envVal.get() : null;
    }

    private static Map<String, Object> loadPatchFile(String path) {
        if (path == null || path.isEmpty()) return Collections.emptyMap();
        String text;
        try {
            text = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(path)),
                    java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            return Collections.emptyMap();
        }
        String ext = path.contains(".") ? path.substring(path.lastIndexOf('.') + 1).toLowerCase() : "";
        if ("json".equals(ext)) {
            try {
                Map<?, ?> raw = new ObjectMapper().readValue(text, Map.class);
                Map<String, Object> result = new HashMap<>();
                for (Map.Entry<?, ?> entry : raw.entrySet()) {
                    result.put(String.valueOf(entry.getKey()), entry.getValue());
                }
                return result;
            } catch (Exception e) {
                return Collections.emptyMap();
            }
        }
        return parsePatchProperties(text);
    }

    private static Map<String, Object> parsePatchProperties(String text) {
        Map<String, Object> result = new HashMap<>();
        for (String line : text.split("\n", -1)) {
            String trimmed = line.replace("\r", "").trim();
            if (trimmed.isEmpty() || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
            int eq = trimmed.indexOf('=');
            if (eq < 0) continue;
            String key = trimmed.substring(0, eq).trim();
            String raw = trimmed.substring(eq + 1).trim();
            if (key.isEmpty()) continue;
            if (raw.isEmpty()) {
                System.err.println("cnos [warn]: patch file key \"" + key + "\" has empty value — skipping");
                continue;
            }
            result.put(key, coercePropertyValue(raw));
        }
        return result;
    }

    private static Object coercePropertyValue(String raw) {
        if ("true".equals(raw)) return Boolean.TRUE;
        if ("false".equals(raw)) return Boolean.FALSE;
        if ("null".equals(raw)) return null;
        if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
            return raw.substring(1, raw.length() - 1);
        }
        try { return Long.parseLong(raw); } catch (NumberFormatException ignored) {}
        try { return Double.parseDouble(raw); } catch (NumberFormatException ignored) {}
        return raw;
    }

    private static final class CoercionResult {
        final Object value; final boolean valid;
        CoercionResult(Object v, boolean ok) { value = v; valid = ok; }
    }

    private static CoercionResult coerceOverrideValue(String raw, String type) {
        if (raw == null || raw.isEmpty()) return new CoercionResult(null, false);
        if ("number".equals(type)) {
            try { return new CoercionResult(Double.parseDouble(raw), true); }
            catch (NumberFormatException e) { return new CoercionResult(null, false); }
        }
        if ("boolean".equals(type)) {
            return new CoercionResult("true".equals(raw) || "1".equals(raw) || "yes".equals(raw), true);
        }
        if ("object".equals(type) || "array".equals(type)) {
            try { return new CoercionResult(new ObjectMapper().readValue(raw, Object.class), true); }
            catch (Exception e) { return new CoercionResult(null, false); }
        }
        return new CoercionResult(raw, true);
    }

    private static Optional<Object> applyOverride(
            ServerProjection.OverrideSpec spec,
            Object cnosVal, boolean cnosFound,
            Map<String, String> parsedArgs,
            Environment env,
            String key) {
        List<String> priority = spec.getPriority() != null && !spec.getPriority().isEmpty()
                ? spec.getPriority() : DEFAULT_PRIORITY;
        String keyLabel = (key != null && !key.isEmpty()) ? " for \"" + key + "\"" : "";
        for (String source : priority) {
            if ("arg".equals(source)) {
                for (String flag : spec.getArg()) {
                    String v = parsedArgs.get(flag);
                    if (v == null) continue;
                    if (v.isEmpty()) {
                        System.err.println("cnos [warn]: arg \"" + flag + "\" has empty value — skipping override" + keyLabel);
                        continue;
                    }
                    CoercionResult r = coerceOverrideValue(v, spec.getType());
                    if (!r.valid) {
                        System.err.println("cnos [warn]: arg \"" + flag + "\" value \"" + v + "\" cannot be coerced to " + (spec.getType() != null ? spec.getType() : "string") + " — skipping override" + keyLabel);
                        continue;
                    }
                    return Optional.ofNullable(r.value);
                }
            } else if ("env".equals(source)) {
                for (String varName : spec.getEnv()) {
                    Optional<String> v = env.get(varName);
                    if (!v.isPresent() || v.get().isEmpty()) continue;
                    CoercionResult r = coerceOverrideValue(v.get(), spec.getType());
                    if (!r.valid) {
                        System.err.println("cnos [warn]: env \"" + varName + "\" value \"" + v.get() + "\" cannot be coerced to " + (spec.getType() != null ? spec.getType() : "string") + " — skipping override" + keyLabel);
                        continue;
                    }
                    return Optional.ofNullable(r.value);
                }
            } else if ("cnos".equals(source)) {
                if (cnosFound) return Optional.ofNullable(cnosVal);
            }
        }
        return cnosFound ? Optional.ofNullable(cnosVal) : Optional.empty();
    }

    // ================================================================
    // Inner state types
    // ================================================================

    static final class WorkspaceState {
        final String id;
        final String source;
        final List<String> chain;

        WorkspaceState(String id, String source, List<String> chain) {
            this.id = id;
            this.source = source;
            this.chain = chain;
        }
    }

    // ================================================================
    // Builder
    // ================================================================

    private static final class Builder {
        ServerProjection projection;
        BootstrappedManifest manifest;
        String profileSource;
        WorkspaceState workspaceState;
        boolean graphBootstrapped;
        Environment env;
        String secretHome;
        Map<String, RuntimeEntry> entries = new HashMap<>();
        Map<String, String> sources = new HashMap<>();
        Set<String> runtimeNamespaces = new HashSet<>();
        Map<String, java.util.function.Function<String, Object>> runtimeProviders = new HashMap<>();
        Map<String, Object> encryptedSecrets;
        Map<String, Object> hydratedSecrets = new HashMap<>();
        Map<String, Map<String, String>> localVaultCache = new HashMap<>();
        Map<String, String> logicalKeyToVault = new HashMap<>();
        Map<String, VaultDefinition> vaults;
        Map<String, SecretVaultProviderFactory> secretFactories = new HashMap<>();
        Map<String, String> parsedArgs;
        Map<String, Object> fileOverrides;

        Builder projection(ServerProjection p) { this.projection = p; return this; }
        Builder manifest(BootstrappedManifest m) { this.manifest = m; return this; }
        Builder profileSource(String s) { this.profileSource = s; return this; }
        Builder workspaceState(WorkspaceState ws) { this.workspaceState = ws; return this; }
        Builder graphBootstrapped(boolean b) { this.graphBootstrapped = b; return this; }
        Builder env(Environment e) { this.env = e; return this; }
        Builder secretHome(String h) { this.secretHome = h; return this; }
        Builder encryptedSecrets(Map<String, Object> s) { this.encryptedSecrets = s; return this; }
        Builder parsedArgs(Map<String, String> a) { this.parsedArgs = a; return this; }
        Builder fileOverrides(Map<String, Object> fo) { this.fileOverrides = fo; return this; }
        Builder factories(List<SecretVaultProviderFactory> f) {
            if (f != null) {
                for (SecretVaultProviderFactory factory : f) {
                    if (factory != null && !factory.getProvider().isEmpty()) {
                        secretFactories.put(factory.getProvider(), factory);
                    }
                }
            }
            return this;
        }

        CnosRuntime build() {
            if (vaults == null) {
                vaults = manifest != null ? manifest.getVaults() : Collections.emptyMap();
            }
            return new CnosRuntime(this);
        }
    }
}
