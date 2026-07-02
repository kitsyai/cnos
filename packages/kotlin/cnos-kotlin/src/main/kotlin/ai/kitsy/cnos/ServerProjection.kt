package ai.kitsy.cnos

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue

@JsonIgnoreProperties(ignoreUnknown = true)
data class DerivedFormula(
    @JsonProperty("expr") val expr: String = "",
    @JsonProperty("deps") val deps: List<String> = emptyList(),
    @JsonProperty("runtimeRefs") val runtimeRefs: List<String> = emptyList()
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class SecretReference(
    @JsonProperty("provider") val provider: String = "",
    @JsonProperty("ref") val ref: String = "",
    @JsonProperty("vault") val vault: String = "",
    @JsonProperty("envVar") val envVar: String? = null
) {
    fun withVault(v: String) = copy(vault = v)
    fun withProvider(p: String) = copy(provider = p)
}

@JsonIgnoreProperties(ignoreUnknown = true)
data class VaultAuth(
    @JsonProperty("method") val method: String = "",
    @JsonProperty("token") val token: String? = null,
    @JsonProperty("role") val role: String? = null,
    @JsonProperty("source") val source: String? = null
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class VaultDefinition(
    @JsonProperty("provider") val provider: String = "",
    @JsonProperty("auth") val auth: VaultAuth = VaultAuth(),
    @JsonProperty("mapping") val mapping: Map<String, String> = emptyMap(),
    @JsonProperty("fallback") val fallback: List<VaultDefinition> = emptyList()
) {
    fun withProvider(p: String) = copy(provider = p)
}

@JsonIgnoreProperties(ignoreUnknown = true)
data class OverrideSpec(
    @JsonProperty("env") val env: List<String> = emptyList(),
    @JsonProperty("arg") val arg: List<String> = emptyList(),
    @JsonProperty("priority") val priority: List<String> = emptyList(),
    @JsonProperty("type") val type: String? = null
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class ProjectionMeta(
    @JsonProperty("workspace") val workspace: String = "",
    @JsonProperty("profile") val profile: String = "",
    @JsonProperty("cnos_version") val cnosVersion: String = "",
    @JsonProperty("namespaces") val namespaces: List<String>? = null
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class ServerProjection(
    @JsonProperty("version") val version: Int = 0,
    @JsonProperty("workspace") val workspace: String = "",
    @JsonProperty("profile") val profile: String = "",
    @JsonProperty("resolvedAt") val resolvedAt: String = "",
    @JsonProperty("configHash") val configHash: String = "",
    @JsonProperty("values") val values: Map<String, Any?> = emptyMap(),
    @JsonProperty("derived") val derived: Map<String, DerivedFormula> = emptyMap(),
    @JsonProperty("secretRefs") val secretRefs: Map<String, SecretReference> = emptyMap(),
    @JsonProperty("publicKeys") val publicKeys: List<String> = emptyList(),
    @JsonProperty("runtimeNamespaces") val runtimeNamespaces: List<String> = emptyList(),
    @JsonProperty("vaults") val vaults: Map<String, VaultDefinition> = emptyMap(),
    @JsonProperty("valueTypes") val valueTypes: Map<String, String> = emptyMap(),
    @JsonProperty("overrides") val overrides: Map<String, OverrideSpec> = emptyMap(),
    @JsonProperty("meta") val meta: ProjectionMeta = ProjectionMeta()
) {
    companion object {
        private val MAPPER = jacksonObjectMapper()

        fun parse(data: ByteArray): ServerProjection {
            val proj = MAPPER.readValue<ServerProjection>(data)
            if (proj.version != 1) throw CnosError("cnos: unsupported projection version: ${proj.version}")
            if (proj.workspace.isBlank()) throw CnosError("cnos: projection missing workspace")
            if (proj.profile.isBlank()) throw CnosError("cnos: projection missing profile")
            if (proj.resolvedAt.isBlank()) throw CnosError("cnos: projection missing resolvedAt")
            if (proj.configHash.isBlank()) throw CnosError("cnos: projection missing configHash")
            return proj
        }
    }
}
