package ai.kitsy.cnos.vault.azure;

import ai.kitsy.cnos.CnosError;
import ai.kitsy.cnos.SecretVaultProvider;
import ai.kitsy.cnos.SecretVaultProviderFactory;
import ai.kitsy.cnos.VaultDefinition;
import com.azure.identity.ChainedTokenCredential;
import com.azure.identity.ChainedTokenCredentialBuilder;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.identity.ManagedIdentityCredentialBuilder;
import com.azure.core.credential.TokenCredential;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.SecretClientBuilder;
import com.azure.security.keyvault.secrets.models.KeyVaultSecret;
import com.azure.core.exception.ResourceNotFoundException;

import java.util.Collections;
import java.util.Map;

/**
 * Factory for the Azure Key Vault provider.
 */
public final class AzureVaultFactory {

    /** Provider name registered by this factory. */
    public static final String PROVIDER = "azure-key-vault";

    private AzureVaultFactory() {}

    /**
     * Returns a factory that uses the real Azure SDK client.
     */
    public static SecretVaultProviderFactory factory() {
        return new SecretVaultProviderFactory(PROVIDER, AzureVaultFactory::create);
    }

    /**
     * Returns a factory that injects a custom client (useful for testing).
     */
    public static SecretVaultProviderFactory factoryWithClient(AzureKeyVaultProvider.Client client) {
        return new SecretVaultProviderFactory(PROVIDER,
                (vaultId, definition) -> createWithClient(vaultId, definition, client));
    }

    private static SecretVaultProvider create(String vaultId, VaultDefinition definition) throws CnosError {
        VaultConfig config = readConfig(definition);
        if (config.vaultUrl == null || config.vaultUrl.isEmpty()) {
            throw new CnosError("vault \"" + vaultId + "\" requires auth.config.vaultUrl");
        }
        AzureKeyVaultProvider.Client client = buildSdkClient(config);
        return buildProvider(vaultId, definition, config, client);
    }

    private static SecretVaultProvider createWithClient(String vaultId, VaultDefinition definition,
            AzureKeyVaultProvider.Client client) {
        VaultConfig config = readConfig(definition);
        return buildProvider(vaultId, definition, config, client);
    }

    private static AzureKeyVaultProvider buildProvider(String vaultId, VaultDefinition definition,
            VaultConfig config, AzureKeyVaultProvider.Client client) {
        return new AzureKeyVaultProvider(vaultId, definition,
                config.vaultUrl, config.origin, config.version, client);
    }

    static AzureKeyVaultProvider.Client buildSdkClient(VaultConfig config) throws CnosError {
        try {
            TokenCredential credential = buildCredential(config);
            SecretClient sdk = new SecretClientBuilder()
                    .vaultUrl(config.vaultUrl)
                    .credential(credential)
                    .buildClient();
            return new SdkClientAdapter(sdk);
        } catch (CnosError e) {
            throw e;
        } catch (Exception e) {
            throw new CnosError("cnos: failed to create Azure Key Vault client: " + e.getMessage(), e);
        }
    }

    private static TokenCredential buildCredential(VaultConfig config) {
        DefaultAzureCredentialBuilder builder = new DefaultAzureCredentialBuilder();
        if (config.tenantId != null && !config.tenantId.isEmpty()) {
            builder.tenantId(config.tenantId);
        }
        TokenCredential defaultCred = builder.build();

        if (config.clientId != null && !config.clientId.isEmpty()) {
            TokenCredential miCred = new ManagedIdentityCredentialBuilder()
                    .clientId(config.clientId)
                    .build();
            // Chain managed identity (client ID) first, then default credential
            return new ChainedTokenCredentialBuilder()
                    .addFirst(miCred)
                    .addLast(defaultCred)
                    .build();
        }
        return defaultCred;
    }

    static VaultConfig readConfig(VaultDefinition definition) {
        Map<String, Object> cfg = definition.getAuth() != null
                ? definition.getAuth().getConfig() : Collections.emptyMap();
        if (cfg == null) cfg = Collections.emptyMap();
        VaultConfig vc = new VaultConfig();
        vc.vaultUrl = firstStringConfig(cfg, "vaultUrl", "url", "endpoint");
        vc.origin = AzureKeyVaultProvider.originForUrl(vc.vaultUrl);
        vc.version = stringConfig(cfg, "version");
        vc.tenantId = firstStringConfig(cfg, "tenantId", "tenant");
        vc.clientId = stringConfig(cfg, "clientId");
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

    static final class VaultConfig {
        String vaultUrl;
        String origin;
        String version;
        String tenantId;
        String clientId;
    }

    private static final class SdkClientAdapter implements AzureKeyVaultProvider.Client {
        private final SecretClient sdk;

        SdkClientAdapter(SecretClient sdk) { this.sdk = sdk; }

        @Override
        public String getSecret(String name, String version) {
            try {
                String ver = (version != null && !version.isEmpty()) ? version : null;
                KeyVaultSecret secret = (ver != null)
                        ? sdk.getSecret(name, ver)
                        : sdk.getSecret(name);
                return secret != null ? secret.getValue() : null;
            } catch (ResourceNotFoundException e) {
                return null;
            }
        }
    }
}
