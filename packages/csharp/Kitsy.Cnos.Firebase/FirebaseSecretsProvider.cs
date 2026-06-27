using System;
using System.Collections.Generic;
using Kitsy.Cnos;
using Kitsy.Cnos.Gcp;

namespace Kitsy.Cnos.Firebase
{
    /// <summary>
    /// CNOS vault provider for Firebase Secrets (backed by GCP Secret Manager).
    /// Register via <c>new SecretVaultProviderFactory("firebase", (id, def) => new FirebaseSecretsProvider(projectId))</c>.
    /// </summary>
    public sealed class FirebaseSecretsProvider : ISecretVaultProvider
    {
        private readonly GcpSecretManagerProvider _gcpProvider;

        /// <param name="projectId">Firebase/GCP project ID.</param>
        public FirebaseSecretsProvider(string projectId)
        {
            _gcpProvider = new GcpSecretManagerProvider(projectId);
        }

        public void Authenticate(VaultAuthConfig auth) => _gcpProvider.Authenticate(auth);

        public Dictionary<string, object?> BatchGet(IReadOnlyList<string> refs) => _gcpProvider.BatchGet(refs);

        public object? Get(string reference) => _gcpProvider.Get(reference);

        /// <summary>Returns a <see cref="SecretVaultProviderFactory"/> for this provider.</summary>
        public static SecretVaultProviderFactory Factory(string projectId) =>
            new SecretVaultProviderFactory("firebase", (_, _) => new FirebaseSecretsProvider(projectId));
    }
}
