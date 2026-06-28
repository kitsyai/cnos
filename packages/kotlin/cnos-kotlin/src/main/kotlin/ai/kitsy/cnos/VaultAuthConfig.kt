package ai.kitsy.cnos

data class VaultAuthConfig(
    val method: String,
    val token: String? = null,
    val role: String? = null,
    val endpoint: String? = null,
    val extra: Map<String, String> = emptyMap()
)
