package ai.kitsy.cnos

interface SecretVaultProvider {
    fun authenticate(auth: VaultAuthConfig)
    fun batchGet(refs: List<String>): Map<String, Any>
    fun get(ref: String): Any?
}

data class SecretVaultProviderFactory(
    val provider: String,
    val create: (vaultId: String, definition: VaultDefinition) -> SecretVaultProvider
)
