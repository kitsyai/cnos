package ai.kitsy.cnos;

/**
 * Registers a {@link SecretVaultProvider} implementation by provider name.
 */
public final class SecretVaultProviderFactory {

    /**
     * Functional interface for constructing a provider instance.
     */
    @FunctionalInterface
    public interface Creator {
        SecretVaultProvider create(String vaultId, VaultDefinition definition) throws CnosError;
    }

    private final String provider;
    private final Creator creator;

    public SecretVaultProviderFactory(String provider, Creator creator) {
        if (provider == null || provider.trim().isEmpty()) {
            throw new IllegalArgumentException("provider name must not be blank");
        }
        if (creator == null) {
            throw new IllegalArgumentException("creator must not be null");
        }
        this.provider = provider.trim();
        this.creator = creator;
    }

    public String getProvider() { return provider; }

    public SecretVaultProvider create(String vaultId, VaultDefinition definition) throws CnosError {
        return creator.create(vaultId, definition);
    }
}
