package ai.kitsy.cnos.vault.aws;

import ai.kitsy.cnos.CnosError;
import ai.kitsy.cnos.SecretVaultProvider;
import ai.kitsy.cnos.SecretVaultProviderFactory;
import ai.kitsy.cnos.VaultDefinition;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.secretsmanager.SecretsManagerClient;
import software.amazon.awssdk.services.secretsmanager.SecretsManagerClientBuilder;

import java.net.URI;

/**
 * Factory for the AWS Secrets Manager vault provider.
 * Register via:
 * <pre>{@code
 * runtime.registerSecretVaultProviders(AwsVaultFactory.factory());
 * }</pre>
 */
public final class AwsVaultFactory {

    /** Provider name registered by this factory. */
    public static final String PROVIDER = "aws-secrets-manager";

    private AwsVaultFactory() {}

    /**
     * Returns a factory that uses the real AWS SDK client.
     */
    public static SecretVaultProviderFactory factory() {
        return new SecretVaultProviderFactory(PROVIDER, AwsVaultFactory::create);
    }

    /**
     * Returns a factory that injects a custom client (useful for testing).
     */
    public static SecretVaultProviderFactory factoryWithClient(AwsSecretsManagerProvider.Client client) {
        return new SecretVaultProviderFactory(PROVIDER,
                (vaultId, definition) -> createWithClient(vaultId, definition, client));
    }

    private static SecretVaultProvider create(String vaultId, VaultDefinition definition) throws CnosError {
        VaultConfig config = readConfig(definition);
        AwsSecretsManagerProvider.Client client = buildSdkClient(config);
        return buildProvider(vaultId, definition, config, client);
    }

    private static SecretVaultProvider createWithClient(String vaultId, VaultDefinition definition,
            AwsSecretsManagerProvider.Client client) {
        VaultConfig config = readConfig(definition);
        return buildProvider(vaultId, definition, config, client);
    }

    private static AwsSecretsManagerProvider buildProvider(String vaultId, VaultDefinition definition,
            VaultConfig config, AwsSecretsManagerProvider.Client client) {
        return new AwsSecretsManagerProvider(vaultId, definition,
                config.versionId, config.versionStage, client);
    }

    private static AwsSecretsManagerProvider.Client buildSdkClient(VaultConfig config) throws CnosError {
        try {
            SecretsManagerClientBuilder builder = SecretsManagerClient.builder();
            if (config.region != null && !config.region.isEmpty()) {
                builder.region(Region.of(config.region));
            }
            if (config.endpoint != null && !config.endpoint.isEmpty()) {
                builder.endpointOverride(URI.create(config.endpoint));
            }
            return new AwsSecretsManagerProvider.SdkClientAdapter(builder.build());
        } catch (Exception e) {
            throw new CnosError("cnos: failed to create AWS Secrets Manager client: " + e.getMessage(), e);
        }
    }

    private static VaultConfig readConfig(VaultDefinition definition) {
        java.util.Map<String, Object> config = definition.getAuth() != null
                ? definition.getAuth().getConfig() : java.util.Collections.emptyMap();
        VaultConfig vc = new VaultConfig();
        vc.region = stringConfig(config, "region");
        vc.endpoint = stringConfig(config, "endpoint");
        vc.versionId = firstStringConfig(config, "versionId", "version");
        vc.versionStage = stringConfig(config, "versionStage");
        return vc;
    }

    private static String stringConfig(java.util.Map<String, Object> config, String key) {
        if (config == null) return null;
        Object v = config.get(key);
        return v instanceof String ? ((String) v).trim() : null;
    }

    private static String firstStringConfig(java.util.Map<String, Object> config, String... keys) {
        for (String key : keys) {
            String v = stringConfig(config, key);
            if (v != null && !v.isEmpty()) return v;
        }
        return null;
    }

    private static final class VaultConfig {
        String region;
        String endpoint;
        String versionId;
        String versionStage;
    }
}
