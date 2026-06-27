using System.Collections.Generic;

namespace Kitsy.Cnos
{
    /// <summary>Pluggable vault backend for resolving secret refs.</summary>
    public interface ISecretVaultProvider
    {
        /// <summary>Authenticates this provider using the resolved auth material.</summary>
        void Authenticate(VaultAuthConfig auth);

        /// <summary>Fetches multiple secret values in one batch operation.</summary>
        Dictionary<string, object?> BatchGet(IReadOnlyList<string> refs);

        /// <summary>Fetches a single secret value. Returns null if not found.</summary>
        object? Get(string reference);
    }

    /// <summary>Factory that creates <see cref="ISecretVaultProvider"/> instances by provider name.</summary>
    public sealed class SecretVaultProviderFactory
    {
        public delegate ISecretVaultProvider Creator(string vaultId, VaultDefinition definition);

        public string ProviderName { get; }
        private readonly Creator _creator;

        public SecretVaultProviderFactory(string providerName, Creator creator)
        {
            if (string.IsNullOrWhiteSpace(providerName))
                throw new System.ArgumentException("providerName must not be blank", nameof(providerName));
            ProviderName = providerName.Trim();
            _creator = creator ?? throw new System.ArgumentNullException(nameof(creator));
        }

        public ISecretVaultProvider Create(string vaultId, VaultDefinition definition) =>
            _creator(vaultId, definition);
    }
}
