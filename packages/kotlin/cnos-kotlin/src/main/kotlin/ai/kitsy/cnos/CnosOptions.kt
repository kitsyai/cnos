package ai.kitsy.cnos

data class CnosOptions(
    val projectionData: ByteArray? = null,
    val projectionPath: String? = null,
    val workingDir: String? = null,
    val environment: Map<String, String>? = null,
    val secretHome: String? = null,
    val secretVaultProviders: List<SecretVaultProviderFactory> = emptyList()
) {
    companion object {
        fun defaults() = CnosOptions()
    }
}
