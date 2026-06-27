using System;
using System.Collections.Generic;
using Amazon;
using Amazon.SecretsManager;
using Amazon.SecretsManager.Model;
using Kitsy.Cnos;

namespace Kitsy.Cnos.Aws
{
    /// <summary>
    /// CNOS vault provider for AWS Secrets Manager.
    /// Register via <c>new SecretVaultProviderFactory("aws", (id, def) => new AwsSecretsManagerProvider())</c>.
    /// </summary>
    public sealed class AwsSecretsManagerProvider : ISecretVaultProvider
    {
        private readonly string? _region;
        private AmazonSecretsManagerClient? _client;

        /// <param name="region">AWS region (e.g. "us-east-1"). Null uses the default SDK chain.</param>
        public AwsSecretsManagerProvider(string? region = null)
        {
            _region = region;
        }

        public void Authenticate(VaultAuthConfig auth)
        {
            string? region = auth.Config?.TryGetValue("region", out object? r) == true ? r?.ToString() : null;
            region ??= _region;

            if (!string.IsNullOrEmpty(region))
                _client = new AmazonSecretsManagerClient(RegionEndpoint.GetBySystemName(region));
            else
                _client = new AmazonSecretsManagerClient();
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

        private object? GetSingle(string secretId)
        {
            if (_client == null)
                throw new CnosError("cnos: AwsSecretsManagerProvider.Authenticate must be called before reading secrets");
            try
            {
                var request = new GetSecretValueRequest { SecretId = secretId };
                var response = _client.GetSecretValueAsync(request).GetAwaiter().GetResult();
                return response.SecretString ?? Convert.ToBase64String(response.SecretBinary?.ToArray() ?? Array.Empty<byte>());
            }
            catch (ResourceNotFoundException)
            {
                return null;
            }
            catch (Exception ex) when (ex is not CnosError)
            {
                throw new CnosError($"cnos: AWS Secrets Manager error for \"{secretId}\": {ex.Message}", ex);
            }
        }

        /// <summary>Returns a <see cref="SecretVaultProviderFactory"/> for this provider.</summary>
        public static SecretVaultProviderFactory Factory(string? region = null) =>
            new SecretVaultProviderFactory("aws", (_, _) => new AwsSecretsManagerProvider(region));
    }
}
