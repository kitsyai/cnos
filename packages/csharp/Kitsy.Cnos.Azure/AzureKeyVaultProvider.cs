using System;
using System.Collections.Generic;
using Azure;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;
using Kitsy.Cnos;

namespace Kitsy.Cnos.Azure
{
    /// <summary>
    /// CNOS vault provider for Azure Key Vault.
    /// Register via <c>new SecretVaultProviderFactory("azure", (id, def) => new AzureKeyVaultProvider(vaultUrl))</c>.
    /// </summary>
    public sealed class AzureKeyVaultProvider : ISecretVaultProvider
    {
        private readonly string _vaultUrl;
        private SecretClient? _client;

        /// <param name="vaultUrl">Azure Key Vault URL (e.g. "https://myvault.vault.azure.net/").</param>
        public AzureKeyVaultProvider(string vaultUrl)
        {
            _vaultUrl = vaultUrl ?? throw new ArgumentNullException(nameof(vaultUrl));
        }

        public void Authenticate(VaultAuthConfig auth)
        {
            string? url = auth.Config?.TryGetValue("vaultUrl", out object? v) == true ? v?.ToString() : null;
            url ??= _vaultUrl;

            string? token = auth.Token;
            global::Azure.Core.TokenCredential credential = !string.IsNullOrEmpty(token)
                ? new ClientSecretCredential(
                    auth.Config?.TryGetValue("tenantId", out object? t) == true ? t?.ToString() ?? "" : "",
                    auth.Config?.TryGetValue("clientId", out object? c) == true ? c?.ToString() ?? "" : "",
                    token!)
                : new DefaultAzureCredential();

            _client = new SecretClient(new Uri(url), credential);
        }

        public Dictionary<string, object?> BatchGet(IReadOnlyList<string> refs)
        {
            var result = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (string @ref in refs)
            {
                object? value = GetSingle(@ref);
                if (value != null) result[@ref] = value;
            }
            return result;
        }

        public object? Get(string reference) => GetSingle(reference);

        private object? GetSingle(string secretName)
        {
            if (_client == null)
                throw new CnosError("cnos: AzureKeyVaultProvider.Authenticate must be called before reading secrets");
            try
            {
                Response<KeyVaultSecret> response = _client.GetSecret(secretName);
                return response.Value.Value;
            }
            catch (RequestFailedException ex) when (ex.Status == 404)
            {
                return null;
            }
            catch (Exception ex) when (ex is not CnosError)
            {
                throw new CnosError($"cnos: Azure Key Vault error for \"{secretName}\": {ex.Message}", ex);
            }
        }

        /// <summary>Returns a <see cref="SecretVaultProviderFactory"/> for this provider.</summary>
        public static SecretVaultProviderFactory Factory(string vaultUrl) =>
            new SecretVaultProviderFactory("azure", (_, _) => new AzureKeyVaultProvider(vaultUrl));
    }
}
