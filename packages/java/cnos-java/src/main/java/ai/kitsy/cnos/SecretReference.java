package ai.kitsy.cnos;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Wire type for a secret reference in a ServerProjection.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public final class SecretReference {

    @JsonProperty("provider")
    private final String provider;

    @JsonProperty("ref")
    private final String ref;

    @JsonProperty("vault")
    private final String vault;

    @JsonProperty("envVar")
    private final String envVar;

    @JsonCreator
    public SecretReference(
            @JsonProperty("provider") String provider,
            @JsonProperty("ref") String ref,
            @JsonProperty("vault") String vault,
            @JsonProperty("envVar") String envVar) {
        this.provider = provider;
        this.ref = ref;
        this.vault = vault;
        this.envVar = envVar;
    }

    public SecretReference withVault(String vault) {
        return new SecretReference(provider, ref, vault, envVar);
    }

    public SecretReference withProvider(String provider) {
        return new SecretReference(provider, ref, vault, envVar);
    }

    public String getProvider() { return provider; }
    public String getRef() { return ref; }
    public String getVault() { return vault; }
    public String getEnvVar() { return envVar; }
}
