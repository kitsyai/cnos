package ai.kitsy.cnos;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Wire type for a CNOS server projection JSON payload.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public final class ServerProjection {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @JsonProperty("version")
    private final int version;

    @JsonProperty("workspace")
    private final String workspace;

    @JsonProperty("profile")
    private final String profile;

    @JsonProperty("resolvedAt")
    private final String resolvedAt;

    @JsonProperty("configHash")
    private final String configHash;

    @JsonProperty("values")
    private final Map<String, Object> values;

    @JsonProperty("derived")
    private final Map<String, DerivedFormula> derived;

    @JsonProperty("secretRefs")
    private final Map<String, SecretReference> secretRefs;

    @JsonProperty("vaults")
    private final Map<String, VaultDefinition> vaults;

    @JsonProperty("publicKeys")
    private final List<String> publicKeys;

    @JsonProperty("runtimeNamespaces")
    private final List<String> runtimeNamespaces;

    @JsonProperty("valueTypes")
    private final Map<String, String> valueTypes;

    @JsonProperty("overrides")
    private final Map<String, OverrideSpec> overrides;

    @JsonProperty("meta")
    private final Meta meta;

    @JsonCreator
    public ServerProjection(
            @JsonProperty("version") int version,
            @JsonProperty("workspace") String workspace,
            @JsonProperty("profile") String profile,
            @JsonProperty("resolvedAt") String resolvedAt,
            @JsonProperty("configHash") String configHash,
            @JsonProperty("values") Map<String, Object> values,
            @JsonProperty("derived") Map<String, DerivedFormula> derived,
            @JsonProperty("secretRefs") Map<String, SecretReference> secretRefs,
            @JsonProperty("vaults") Map<String, VaultDefinition> vaults,
            @JsonProperty("publicKeys") List<String> publicKeys,
            @JsonProperty("runtimeNamespaces") List<String> runtimeNamespaces,
            @JsonProperty("valueTypes") Map<String, String> valueTypes,
            @JsonProperty("overrides") Map<String, OverrideSpec> overrides,
            @JsonProperty("meta") Meta meta) {
        this.version = version;
        this.workspace = workspace;
        this.profile = profile;
        this.resolvedAt = resolvedAt;
        this.configHash = configHash;
        this.values = values != null ? Collections.unmodifiableMap(values) : Collections.emptyMap();
        this.derived = derived != null ? Collections.unmodifiableMap(derived) : Collections.emptyMap();
        this.secretRefs = secretRefs != null ? Collections.unmodifiableMap(secretRefs) : Collections.emptyMap();
        this.vaults = vaults != null ? Collections.unmodifiableMap(vaults) : Collections.emptyMap();
        this.publicKeys = publicKeys != null ? Collections.unmodifiableList(publicKeys) : Collections.emptyList();
        this.runtimeNamespaces = runtimeNamespaces != null
                ? Collections.unmodifiableList(runtimeNamespaces) : Collections.emptyList();
        this.valueTypes = valueTypes != null ? Collections.unmodifiableMap(valueTypes) : Collections.emptyMap();
        this.overrides = overrides != null ? Collections.unmodifiableMap(overrides) : Collections.emptyMap();
        this.meta = meta;
    }

    /**
     * Parses and validates a JSON byte array into a ServerProjection.
     *
     * @param data UTF-8 JSON bytes
     * @return parsed and validated projection
     * @throws CnosError if the JSON is malformed or the payload is invalid
     */
    public static ServerProjection parse(byte[] data) throws CnosError {
        ServerProjection raw;
        try {
            raw = MAPPER.readValue(data, ServerProjection.class);
        } catch (IOException e) {
            throw new CnosError("cnos: parse server projection: " + e.getMessage(), e);
        }

        if (raw.version != 1
                || isBlank(raw.workspace)
                || isBlank(raw.profile)
                || isBlank(raw.resolvedAt)
                || isBlank(raw.configHash)
                || raw.values == null
                || raw.secretRefs == null
                || raw.publicKeys == null
                || raw.meta == null
                || isBlank(raw.meta.getWorkspace())
                || isBlank(raw.meta.getProfile())
                || isBlank(raw.meta.getCnosVersion())) {
            throw new CnosError("cnos: invalid server projection payload");
        }

        // Normalize secretRefs — fill in missing vault and provider fields
        Map<String, SecretReference> normalizedRefs = new HashMap<>(raw.secretRefs);
        for (Map.Entry<String, SecretReference> entry : normalizedRefs.entrySet()) {
            SecretReference ref = entry.getValue();
            String vault = ref.getVault();
            if (vault == null || vault.isEmpty()) {
                vault = "default";
                ref = ref.withVault(vault);
            }
            if (ref.getProvider() == null || ref.getProvider().isEmpty()) {
                VaultDefinition def = raw.vaults != null ? raw.vaults.get(vault) : null;
                String provider = (def != null && def.getProvider() != null && !def.getProvider().isEmpty())
                        ? def.getProvider() : "local";
                ref = ref.withProvider(provider);
            }
            normalizedRefs.put(entry.getKey(), ref);
        }

        return new ServerProjection(
                raw.version,
                raw.workspace,
                raw.profile,
                raw.resolvedAt,
                raw.configHash,
                raw.values,
                raw.derived,
                normalizedRefs,
                raw.vaults,
                raw.publicKeys,
                raw.runtimeNamespaces,
                raw.valueTypes,
                raw.overrides,
                raw.meta);
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }

    public int getVersion() { return version; }
    public String getWorkspace() { return workspace; }
    public String getProfile() { return profile; }
    public String getResolvedAt() { return resolvedAt; }
    public String getConfigHash() { return configHash; }
    public Map<String, Object> getValues() { return values; }
    public Map<String, DerivedFormula> getDerived() { return derived; }
    public Map<String, SecretReference> getSecretRefs() { return secretRefs; }
    public Map<String, VaultDefinition> getVaults() { return vaults; }
    public List<String> getPublicKeys() { return publicKeys; }
    public List<String> getRuntimeNamespaces() { return runtimeNamespaces; }
    public Map<String, String> getValueTypes() { return valueTypes; }
    public Map<String, OverrideSpec> getOverrides() { return overrides; }
    public Meta getMeta() { return meta; }

    /** Schema-level env/arg override configuration for one config key. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class OverrideSpec {

        @JsonProperty("env")
        private final List<String> env;

        @JsonProperty("arg")
        private final List<String> arg;

        @JsonProperty("priority")
        private final List<String> priority;

        @JsonProperty("type")
        private final String type;

        @JsonCreator
        public OverrideSpec(
                @JsonProperty("env") List<String> env,
                @JsonProperty("arg") List<String> arg,
                @JsonProperty("priority") List<String> priority,
                @JsonProperty("type") String type) {
            this.env = env != null ? Collections.unmodifiableList(env) : Collections.emptyList();
            this.arg = arg != null ? Collections.unmodifiableList(arg) : Collections.emptyList();
            this.priority = priority != null ? Collections.unmodifiableList(priority) : Collections.emptyList();
            this.type = type;
        }

        public List<String> getEnv() { return env; }
        public List<String> getArg() { return arg; }
        public List<String> getPriority() { return priority; }
        public String getType() { return type; }
    }

    /**
     * Projection metadata block.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class Meta {

        @JsonProperty("workspace")
        private final String workspace;

        @JsonProperty("profile")
        private final String profile;

        @JsonProperty("cnos_version")
        private final String cnosVersion;

        @JsonProperty("namespaces")
        private final List<String> namespaces;

        @JsonCreator
        public Meta(
                @JsonProperty("workspace") String workspace,
                @JsonProperty("profile") String profile,
                @JsonProperty("cnos_version") String cnosVersion,
                @JsonProperty("namespaces") List<String> namespaces) {
            this.workspace = workspace;
            this.profile = profile;
            this.cnosVersion = cnosVersion;
            this.namespaces = namespaces != null ? Collections.unmodifiableList(namespaces) : Collections.emptyList();
        }

        public String getWorkspace() { return workspace; }
        public String getProfile() { return profile; }
        public String getCnosVersion() { return cnosVersion; }
        public List<String> getNamespaces() { return namespaces; }
    }
}
