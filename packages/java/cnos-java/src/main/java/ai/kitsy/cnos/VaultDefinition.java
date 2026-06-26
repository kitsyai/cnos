package ai.kitsy.cnos;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Vault definition — both JSON wire form and provider API type.
 * Maps to the internal {@code vaultDefinition} / public {@code VaultDefinition} Go types.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public final class VaultDefinition {

    @JsonProperty("provider")
    private final String provider;

    @JsonProperty("auth")
    private final Auth auth;

    @JsonProperty("mapping")
    private final Map<String, String> mapping;

    @JsonProperty("fallback")
    private final List<VaultDefinition> fallback;

    @JsonCreator
    public VaultDefinition(
            @JsonProperty("provider") String provider,
            @JsonProperty("auth") Auth auth,
            @JsonProperty("mapping") Map<String, String> mapping,
            @JsonProperty("fallback") List<VaultDefinition> fallback) {
        this.provider = provider;
        this.auth = auth != null ? auth : new Auth(null, null, null, null);
        this.mapping = mapping != null ? Collections.unmodifiableMap(mapping) : Collections.emptyMap();
        this.fallback = fallback != null ? Collections.unmodifiableList(fallback) : Collections.emptyList();
    }

    public VaultDefinition withProvider(String provider) {
        return new VaultDefinition(provider, auth, mapping, fallback);
    }

    public String getProvider() { return provider; }
    public Auth getAuth() { return auth; }
    public Map<String, String> getMapping() { return mapping; }
    public List<VaultDefinition> getFallback() { return fallback; }

    /**
     * Auth section of a vault definition.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class Auth {

        @JsonProperty("method")
        private final String method;

        @JsonProperty("passphrase")
        private final AuthSource passphrase;

        @JsonProperty("token")
        private final AuthSource token;

        @JsonProperty("config")
        private final Map<String, Object> config;

        @JsonCreator
        public Auth(
                @JsonProperty("method") String method,
                @JsonProperty("passphrase") AuthSource passphrase,
                @JsonProperty("token") AuthSource token,
                @JsonProperty("config") Map<String, Object> config) {
            this.method = method;
            this.passphrase = passphrase;
            this.token = token;
            this.config = config != null ? Collections.unmodifiableMap(config) : Collections.emptyMap();
        }

        public String getMethod() { return method; }
        public AuthSource getPassphrase() { return passphrase; }
        public AuthSource getToken() { return token; }
        public Map<String, Object> getConfig() { return config; }
    }

    /**
     * Auth source — describes where runtime auth material can be resolved from.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class AuthSource {

        @JsonProperty("from")
        private final List<String> from;

        @JsonCreator
        public AuthSource(@JsonProperty("from") List<String> from) {
            this.from = from != null ? Collections.unmodifiableList(from) : Collections.emptyList();
        }

        public List<String> getFrom() { return from; }
    }
}
