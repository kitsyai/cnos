package ai.kitsy.cnos.vault.firebase

import ai.kitsy.cnos.SecretVaultProvider
import ai.kitsy.cnos.SecretVaultProviderFactory
import ai.kitsy.cnos.VaultAuthConfig
import ai.kitsy.cnos.VaultDefinition
import ai.kitsy.cnos.vault.gcp.GcpSecretManagerProvider

class FirebaseSecretsProvider(vaultId: String, def: VaultDefinition) : SecretVaultProvider {
    private val gcp = GcpSecretManagerProvider(vaultId, def)

    override fun authenticate(auth: VaultAuthConfig) = gcp.authenticate(auth)
    override fun batchGet(refs: List<String>): Map<String, Any> = gcp.batchGet(refs)
    override fun get(ref: String): Any? = gcp.get(ref)

    companion object {
        fun factory(): SecretVaultProviderFactory = SecretVaultProviderFactory("firebase") { vaultId, def ->
            FirebaseSecretsProvider(vaultId, def)
        }
    }
}
