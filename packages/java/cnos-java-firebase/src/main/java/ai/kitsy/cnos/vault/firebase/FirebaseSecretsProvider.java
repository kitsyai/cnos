package ai.kitsy.cnos.vault.firebase;

import ai.kitsy.cnos.CnosError;
import ai.kitsy.cnos.SecretVaultProvider;
import ai.kitsy.cnos.VaultAuthConfig;
import ai.kitsy.cnos.vault.gcp.GcpSecretManagerProvider;

import java.util.List;
import java.util.Map;

/**
 * CNOS provider for Firebase Secrets.
 * Provider name: {@code firebase-secrets}.
 * Delegates entirely to {@link GcpSecretManagerProvider} — Firebase projects are GCP projects
 * and Firebase Secrets uses the same GCP Secret Manager API.
 */
public final class FirebaseSecretsProvider implements SecretVaultProvider {

    private final SecretVaultProvider delegate;

    FirebaseSecretsProvider(SecretVaultProvider gcpDelegate) {
        this.delegate = gcpDelegate;
    }

    @Override
    public void authenticate(VaultAuthConfig auth) throws CnosError {
        delegate.authenticate(auth);
    }

    @Override
    public Map<String, Object> batchGet(List<String> refs) throws CnosError {
        return delegate.batchGet(refs);
    }

    @Override
    public Object get(String ref) throws CnosError {
        return delegate.get(ref);
    }
}
