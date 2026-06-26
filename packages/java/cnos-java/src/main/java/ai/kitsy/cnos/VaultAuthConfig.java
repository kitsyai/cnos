package ai.kitsy.cnos;

import java.util.Collections;
import java.util.Map;

/**
 * Resolved in-memory auth material for a vault, passed to {@link SecretVaultProvider#authenticate}.
 */
public final class VaultAuthConfig {

    private final String method;
    private final String passphrase;
    private final String token;
    private final Map<String, Object> config;

    public VaultAuthConfig(String method, String passphrase, String token, Map<String, Object> config) {
        this.method = method;
        this.passphrase = passphrase;
        this.token = token;
        this.config = config != null ? Collections.unmodifiableMap(config) : Collections.emptyMap();
    }

    public static VaultAuthConfig ofMethod(String method, Map<String, Object> config) {
        return new VaultAuthConfig(method, null, null, config);
    }

    public static VaultAuthConfig ofToken(String token, Map<String, Object> config) {
        return new VaultAuthConfig("token", null, token, config);
    }

    public static VaultAuthConfig ofPassphrase(String passphrase, Map<String, Object> config) {
        return new VaultAuthConfig("passphrase", passphrase, null, config);
    }

    public String getMethod() { return method; }
    public String getPassphrase() { return passphrase; }
    public String getToken() { return token; }
    public Map<String, Object> getConfig() { return config; }
}
