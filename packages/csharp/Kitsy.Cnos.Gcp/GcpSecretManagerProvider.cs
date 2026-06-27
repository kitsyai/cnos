using System;
using System.Collections.Generic;
using System.Text;
using Google.Api.Gax.ResourceNames;
using Google.Cloud.SecretManager.V1;
using Grpc.Core;
using Kitsy.Cnos;

namespace Kitsy.Cnos.Gcp
{
    /// <summary>
    /// CNOS vault provider for Google Cloud Secret Manager.
    /// Register via <c>new SecretVaultProviderFactory("gcp", (id, def) => new GcpSecretManagerProvider(projectId))</c>.
    /// </summary>
    public sealed class GcpSecretManagerProvider : ISecretVaultProvider
    {
        private readonly string _projectId;
        private SecretManagerServiceClient? _client;

        /// <param name="projectId">GCP project ID.</param>
        public GcpSecretManagerProvider(string projectId)
        {
            _projectId = projectId ?? throw new ArgumentNullException(nameof(projectId));
        }

        public void Authenticate(VaultAuthConfig auth)
        {
            _client = SecretManagerServiceClient.Create();
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
                throw new CnosError("cnos: GcpSecretManagerProvider.Authenticate must be called before reading secrets");
            try
            {
                string resourceName = $"projects/{_projectId}/secrets/{secretId}/versions/latest";
                AccessSecretVersionResponse response = _client.AccessSecretVersion(resourceName);
                return response.Payload.Data.ToStringUtf8();
            }
            catch (RpcException ex) when (ex.StatusCode == StatusCode.NotFound)
            {
                return null;
            }
            catch (Exception ex) when (ex is not CnosError)
            {
                throw new CnosError($"cnos: GCP Secret Manager error for \"{secretId}\": {ex.Message}", ex);
            }
        }

        /// <summary>Returns a <see cref="SecretVaultProviderFactory"/> for this provider.</summary>
        public static SecretVaultProviderFactory Factory(string projectId) =>
            new SecretVaultProviderFactory("gcp", (_, _) => new GcpSecretManagerProvider(projectId));
    }
}
