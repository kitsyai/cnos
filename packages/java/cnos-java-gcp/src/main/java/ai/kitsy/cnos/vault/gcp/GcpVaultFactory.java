package ai.kitsy.cnos.vault.gcp;

import ai.kitsy.cnos.CnosError;
import ai.kitsy.cnos.SecretVaultProvider;
import ai.kitsy.cnos.SecretVaultProviderFactory;
import ai.kitsy.cnos.VaultDefinition;
import com.google.cloud.secretmanager.v1.AccessSecretVersionRequest;
import com.google.cloud.secretmanager.v1.SecretManagerServiceClient;
import com.google.cloud.secretmanager.v1.SecretManagerServiceSettings;

import java.util.Map;
import java.util.Collections;

/**
 * Factory for the GCP Secret Manager vault provider.
 */
public final class GcpVaultFactory {

    /** Provider name registered by this factory. */
    public static final String PROVIDER = "gcp-secret-manager";

    private GcpVaultFactory() {}

    /**
     * Returns a factory that uses the real GCP SDK client.
     */
    public static SecretVaultProviderFactory factory() {
        return new SecretVaultProviderFactory(PROVIDER, GcpVaultFactory::create);
    }

    /**
     * Returns a factory that injects a custom client (useful for testing).
     */
    public static SecretVaultProviderFactory factoryWithClient(GcpSecretManagerProvider.Client client) {
        return new SecretVaultProviderFactory(PROVIDER,
                (vaultId, definition) -> createWithClient(vaultId, definition, client));
    }

    private static SecretVaultProvider create(String vaultId, VaultDefinition definition) throws CnosError {
        VaultConfig config = readConfig(definition);
        GcpSecretManagerProvider.Client client = buildSdkClient(config);
        return buildProvider(vaultId, definition, config, client);
    }

    private static SecretVaultProvider createWithClient(String vaultId, VaultDefinition definition,
            GcpSecretManagerProvider.Client client) {
        VaultConfig config = readConfig(definition);
        return buildProvider(vaultId, definition, config, client);
    }

    private static GcpSecretManagerProvider buildProvider(String vaultId, VaultDefinition definition,
            VaultConfig config, GcpSecretManagerProvider.Client client) {
        return new GcpSecretManagerProvider(vaultId, definition,
                config.projectId, config.location, config.version, client);
    }

    public static GcpSecretManagerProvider.Client buildSdkClient(VaultConfig config) throws CnosError {
        try {
            SecretManagerServiceSettings.Builder settingsBuilder = SecretManagerServiceSettings.newBuilder();
            if (config.endpoint != null && !config.endpoint.isEmpty()) {
                settingsBuilder.setEndpoint(config.endpoint);
            }
            SecretManagerServiceClient sdk = SecretManagerServiceClient.create(settingsBuilder.build());
            return new SdkClientAdapter(sdk);
        } catch (Exception e) {
            throw new CnosError("cnos: failed to create GCP Secret Manager client: " + e.getMessage(), e);
        }
    }

    public static VaultConfig readConfig(VaultDefinition definition) {
        Map<String, Object> config = definition.getAuth() != null
                ? definition.getAuth().getConfig() : Collections.emptyMap();
        VaultConfig vc = new VaultConfig();
        vc.projectId = stringConfig(config, "projectId");
        vc.location = stringConfig(config, "location");
        vc.version = stringConfig(config, "version");
        vc.endpoint = firstStringConfig(config, "endpoint", "apiEndpoint");
        return vc;
    }

    static String stringConfig(Map<String, Object> config, String key) {
        if (config == null) return null;
        Object v = config.get(key);
        return v instanceof String ? ((String) v).trim() : null;
    }

    static String firstStringConfig(Map<String, Object> config, String... keys) {
        for (String key : keys) {
            String v = stringConfig(config, key);
            if (v != null && !v.isEmpty()) return v;
        }
        return null;
    }

    public static final class VaultConfig {
        public String projectId;
        public String location;
        public String version;
        public String endpoint;
    }

    private static final class SdkClientAdapter implements GcpSecretManagerProvider.Client {
        private final SecretManagerServiceClient sdk;

        SdkClientAdapter(SecretManagerServiceClient sdk) { this.sdk = sdk; }

        @Override
        public byte[] accessSecretVersion(String name) {
            com.google.cloud.secretmanager.v1.AccessSecretVersionResponse response =
                    sdk.accessSecretVersion(AccessSecretVersionRequest.newBuilder().setName(name).build());
            return response.getPayload().getData().toByteArray();
        }

        @Override
        public String projectId() throws Exception {
            com.google.auth.oauth2.GoogleCredentials credentials =
                    com.google.auth.oauth2.GoogleCredentials.getApplicationDefault();
            if (credentials instanceof com.google.auth.oauth2.ServiceAccountCredentials) {
                return ((com.google.auth.oauth2.ServiceAccountCredentials) credentials).getProjectId();
            }
            return null;
        }
    }
}
