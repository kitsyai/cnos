package ai.kitsy.cnos.vault.firebase;

import ai.kitsy.cnos.CnosError;
import ai.kitsy.cnos.SecretVaultProvider;
import ai.kitsy.cnos.SecretVaultProviderFactory;
import ai.kitsy.cnos.VaultDefinition;
import ai.kitsy.cnos.vault.gcp.GcpSecretManagerProvider;
import ai.kitsy.cnos.vault.gcp.GcpVaultFactory;

/**
 * Factory for the Firebase Secrets vault provider.
 * Firebase Secrets delegates to GCP Secret Manager under the hood.
 */
public final class FirebaseVaultFactory {

    /** Provider name registered by this factory. */
    public static final String PROVIDER = "firebase-secrets";

    /** Internal GCP provider name (used when building the delegate). */
    static final String GCP_PROVIDER = GcpVaultFactory.PROVIDER;

    private FirebaseVaultFactory() {}

    /**
     * Returns a factory that uses the real GCP SDK client.
     */
    public static SecretVaultProviderFactory factory() {
        return new SecretVaultProviderFactory(PROVIDER, FirebaseVaultFactory::create);
    }

    /**
     * Returns a factory that injects a custom GCP client (useful for testing).
     */
    public static SecretVaultProviderFactory factoryWithClient(GcpSecretManagerProvider.Client client) {
        return new SecretVaultProviderFactory(PROVIDER,
                (vaultId, definition) -> createWithClient(vaultId, definition, client));
    }

    private static SecretVaultProvider create(String vaultId, VaultDefinition definition) throws CnosError {
        VaultDefinition gcpDefinition = toGcpDefinition(definition);
        GcpVaultFactory.VaultConfig config = GcpVaultFactory.readConfig(gcpDefinition);
        GcpSecretManagerProvider.Client gcpClient = GcpVaultFactory.buildSdkClient(config);
        return buildProvider(vaultId, gcpDefinition, config, gcpClient);
    }

    private static SecretVaultProvider createWithClient(String vaultId, VaultDefinition definition,
            GcpSecretManagerProvider.Client client) {
        VaultDefinition gcpDefinition = toGcpDefinition(definition);
        GcpVaultFactory.VaultConfig config = GcpVaultFactory.readConfig(gcpDefinition);
        return buildProvider(vaultId, gcpDefinition, config, client);
    }

    private static SecretVaultProvider buildProvider(String vaultId, VaultDefinition gcpDefinition,
            GcpVaultFactory.VaultConfig config, GcpSecretManagerProvider.Client client) {
        GcpSecretManagerProvider gcpProvider = new GcpSecretManagerProvider(vaultId, gcpDefinition,
                config.projectId, config.location, config.version, client);
        return new FirebaseSecretsProvider(gcpProvider);
    }

    /**
     * Returns a copy of the definition with the provider set to "gcp-secret-manager".
     * Firebase Secrets shares the same API and config structure as GCP Secret Manager.
     */
    private static VaultDefinition toGcpDefinition(VaultDefinition definition) {
        return new VaultDefinition(GCP_PROVIDER,
                definition.getAuth(),
                definition.getMapping(),
                definition.getFallback());
    }
}
