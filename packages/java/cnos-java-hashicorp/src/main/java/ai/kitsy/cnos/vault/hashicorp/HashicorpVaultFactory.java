package ai.kitsy.cnos.vault.hashicorp;

import ai.kitsy.cnos.SecretVaultProvider;
import ai.kitsy.cnos.SecretVaultProviderFactory;
import ai.kitsy.cnos.VaultDefinition;

import java.util.Collections;
import java.util.Map;

/**
 * Factory for the HashiCorp Vault KV provider.
 */
public final class HashicorpVaultFactory {

    /** Provider name registered by this factory. */
    public static final String PROVIDER = "hashicorp-vault";

    private HashicorpVaultFactory() {}

    /**
     * Returns a factory that uses real HTTP to talk to HashiCorp Vault.
     */
    public static SecretVaultProviderFactory factory() {
        return new SecretVaultProviderFactory(PROVIDER, HashicorpVaultFactory::create);
    }

    /**
     * Returns a factory that injects a custom client (useful for testing).
     */
    public static SecretVaultProviderFactory factoryWithClient(HashicorpVaultProvider.Client client) {
        return new SecretVaultProviderFactory(PROVIDER,
                (vaultId, definition) -> createWithClient(vaultId, definition, client));
    }

    private static SecretVaultProvider create(String vaultId, VaultDefinition definition) {
        VaultConfig config = readConfig(definition);
        HashicorpVaultProvider.Client client = new HashicorpVaultProvider.HttpClientAdapter(config.address);
        return buildProvider(vaultId, definition, config, client);
    }

    private static SecretVaultProvider createWithClient(String vaultId, VaultDefinition definition,
            HashicorpVaultProvider.Client client) {
        VaultConfig config = readConfig(definition);
        return buildProvider(vaultId, definition, config, client);
    }

    private static HashicorpVaultProvider buildProvider(String vaultId, VaultDefinition definition,
            VaultConfig config, HashicorpVaultProvider.Client client) {
        return new HashicorpVaultProvider(vaultId, definition,
                config.address, config.mount, config.namespace,
                config.version, config.path, client);
    }

    static VaultConfig readConfig(VaultDefinition definition) {
        Map<String, Object> cfg = definition.getAuth() != null
                ? definition.getAuth().getConfig() : Collections.emptyMap();
        if (cfg == null) cfg = Collections.emptyMap();
        VaultConfig vc = new VaultConfig();
        vc.address = stringConfig(cfg, "address");
        vc.mount = stringConfig(cfg, "mount");
        vc.namespace = stringConfig(cfg, "namespace");
        vc.path = stringConfig(cfg, "path");
        Object ver = cfg.get("version");
        if (ver instanceof Number) {
            vc.version = ((Number) ver).intValue();
        } else if (ver instanceof String) {
            try { vc.version = Integer.parseInt((String) ver); } catch (NumberFormatException ignored) {}
        }
        // defaults
        if (vc.mount == null || vc.mount.isEmpty()) vc.mount = "secret";
        if (vc.version == 0) vc.version = 2;
        return vc;
    }

    static String stringConfig(Map<String, Object> config, String key) {
        if (config == null) return null;
        Object v = config.get(key);
        return v instanceof String ? ((String) v).trim() : null;
    }

    static final class VaultConfig {
        String address;
        String mount = "secret";
        String namespace;
        int version = 2;
        String path;
    }
}
