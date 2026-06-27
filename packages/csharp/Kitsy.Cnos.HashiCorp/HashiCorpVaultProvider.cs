using System;
using System.Collections.Generic;
using VaultSharp;
using VaultSharp.V1.AuthMethods;
using VaultSharp.V1.AuthMethods.Token;
using Kitsy.Cnos;

namespace Kitsy.Cnos.HashiCorp
{
    /// <summary>
    /// CNOS vault provider for HashiCorp Vault.
    /// Register via <c>new SecretVaultProviderFactory("hashicorp", (id, def) => new HashiCorpVaultProvider(address))</c>.
    /// </summary>
    public sealed class HashiCorpVaultProvider : ISecretVaultProvider
    {
        private readonly string _address;
        private readonly string? _mountPath;
        private IVaultClient? _client;

        /// <param name="address">Vault server address (e.g. "https://vault.example.com:8200").</param>
        /// <param name="mountPath">KV v2 mount path (default "secret").</param>
        public HashiCorpVaultProvider(string address, string? mountPath = null)
        {
            _address = address ?? throw new ArgumentNullException(nameof(address));
            _mountPath = mountPath;
        }

        public void Authenticate(VaultAuthConfig auth)
        {
            string? address = auth.Config?.TryGetValue("address", out object? a) == true ? a?.ToString() : null;
            address ??= _address;

            IAuthMethodInfo authMethod = !string.IsNullOrEmpty(auth.Token)
                ? new TokenAuthMethodInfo(auth.Token!)
                : new TokenAuthMethodInfo(System.Environment.GetEnvironmentVariable("VAULT_TOKEN") ?? "");

            var settings = new VaultClientSettings(address, authMethod);
            _client = new VaultClient(settings);
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

        private object? GetSingle(string secretPath)
        {
            if (_client == null)
                throw new CnosError("cnos: HashiCorpVaultProvider.Authenticate must be called before reading secrets");

            try
            {
                string mount = _mountPath ?? "secret";
                // secretPath format: "path/to/secret#key" — split on '#' to get the field key
                string path = secretPath;
                string field = "value";
                int hash = secretPath.IndexOf('#');
                if (hash >= 0)
                {
                    path = secretPath.Substring(0, hash);
                    field = secretPath.Substring(hash + 1);
                }

                var secret = _client.V1.Secrets.KeyValue.V2
                    .ReadSecretAsync(path: path, mountPoint: mount)
                    .GetAwaiter().GetResult();

                if (secret?.Data?.Data?.TryGetValue(field, out object? value) == true)
                    return value?.ToString();

                return null;
            }
            catch (Exception ex) when (ex is not CnosError)
            {
                if (ex.Message.Contains("404") || ex.Message.Contains("not found"))
                    return null;
                throw new CnosError($"cnos: HashiCorp Vault error for \"{secretPath}\": {ex.Message}", ex);
            }
        }

        /// <summary>Returns a <see cref="SecretVaultProviderFactory"/> for this provider.</summary>
        public static SecretVaultProviderFactory Factory(string address, string? mountPath = null) =>
            new SecretVaultProviderFactory("hashicorp", (_, _) => new HashiCorpVaultProvider(address, mountPath));
    }
}
