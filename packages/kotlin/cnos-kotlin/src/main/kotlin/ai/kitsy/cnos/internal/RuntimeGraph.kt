package ai.kitsy.cnos.internal

import ai.kitsy.cnos.CnosError
import ai.kitsy.cnos.DerivedFormula
import ai.kitsy.cnos.OverrideSpec
import ai.kitsy.cnos.SecretReference
import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue

@JsonIgnoreProperties(ignoreUnknown = true)
internal data class RuntimeGraph(
    @JsonProperty("entries") val entries: List<GraphResolvedEntry> = emptyList(),
    @JsonProperty("profile") val profile: String = "",
    @JsonProperty("resolvedAt") val resolvedAt: String = "",
    @JsonProperty("profileSource") val profileSource: String = "",
    @JsonProperty("workspace") val workspace: GraphWorkspace = GraphWorkspace(),
    @JsonProperty("overrides") val overrides: Map<String, OverrideSpec> = emptyMap()
)

@JsonIgnoreProperties(ignoreUnknown = true)
internal data class GraphResolvedEntry(
    @JsonProperty("key") val key: String = "",
    @JsonProperty("value") val value: Any? = null,
    @JsonProperty("namespace") val namespace: String = "",
    @JsonProperty("winner") val winner: GraphConfigEntry = GraphConfigEntry(),
    @JsonProperty("overridden") val overridden: List<GraphConfigEntry> = emptyList()
)

@JsonIgnoreProperties(ignoreUnknown = true)
internal data class GraphConfigEntry(
    @JsonProperty("key") val key: String = "",
    @JsonProperty("value") val value: Any? = null,
    @JsonProperty("namespace") val namespace: String = "",
    @JsonProperty("sourceId") val sourceId: String = "",
    @JsonProperty("pluginId") val pluginId: String = "",
    @JsonProperty("workspaceId") val workspaceId: String = "",
    @JsonProperty("metadata") val metadata: Map<String, Any?> = emptyMap()
)

@JsonIgnoreProperties(ignoreUnknown = true)
internal data class GraphWorkspace(
    @JsonProperty("workspaceId") val workspaceId: String = "",
    @JsonProperty("workspaceSource") val workspaceSource: String = "",
    @JsonProperty("workspaceChain") val workspaceChain: List<String> = emptyList()
)

internal object GraphParser {

    private val MAPPER = jacksonObjectMapper()

    fun parseRuntimeGraph(data: ByteArray): RuntimeGraph {
        val graph = try {
            MAPPER.readValue<RuntimeGraph>(data)
        } catch (e: Exception) {
            throw CnosError("cnos: failed to parse runtime graph: ${e.message}", e)
        }
        if (graph.profile.isEmpty() || graph.resolvedAt.isEmpty() || graph.profileSource.isEmpty()
            || graph.workspace.workspaceId.isEmpty() || graph.workspace.workspaceSource.isEmpty()) {
            throw CnosError("cnos: invalid runtime graph payload")
        }
        for (entry in graph.entries) {
            if (entry.key.isEmpty() || entry.namespace.isEmpty()
                || entry.winner.sourceId.isEmpty() || entry.winner.pluginId.isEmpty()
                || entry.winner.workspaceId.isEmpty()) {
                throw CnosError("cnos: invalid runtime graph payload")
            }
        }
        return graph
    }

    fun bootstrappedManifestFromGraph(graph: RuntimeGraph): BootstrappedManifest {
        val ns = BootstrappedManifest.DEFAULT_NAMESPACES.toMutableMap()
        for (entry in graph.entries) {
            val entryNs = entry.namespace
            if (entryNs.isNotEmpty() && entryNs !in ns) {
                ns[entryNs] = NamespaceDef(BootstrappedManifest.KIND_DATA, false, true, false, null)
            }
        }
        return BootstrappedManifest(ns, BootstrappedManifest.DEFAULT_FRAMEWORKS.toMap(), emptyMap(), emptyMap())
    }

    // Returns (RuntimeEntry, vaultId?) — vaultId is non-null for secret entries that have a vault
    fun runtimeEntryFromGraph(resolved: GraphResolvedEntry): Pair<RuntimeEntry, String?> {
        val promotedFrom = (resolved.winner.metadata["promotedFrom"] as? String)
            ?.takeIf { it.isNotEmpty() }

        if (resolved.namespace == "secret") {
            val v = resolved.value
            if (v != null && isSecretReferenceValue(v)) {
                val ref = toSecretReference(v)
                val vaultId = ref.vault.takeIf { it.isNotEmpty() }
                return Pair(
                    RuntimeEntry(
                        key = resolved.key,
                        namespace = resolved.namespace,
                        aliasTo = null,
                        promotedFrom = promotedFrom,
                        secretRef = ref
                    ),
                    vaultId
                )
            }
        }

        val v = resolved.value
        if (v != null && Derive.isDerivedValue(v)) {
            val expr = v as String
            val raw = DerivedFormula(expr = expr)
            val parsed = Derive.parseDerivedFormula(raw)
            val withDeps = parsed.copy(deps = Derive.uniqueSorted(Derive.allRefs(parsed.ast).toMutableList()))
            return Pair(
                RuntimeEntry(
                    key = resolved.key,
                    namespace = resolved.namespace,
                    formula = withDeps,
                    promotedFrom = promotedFrom
                ),
                null
            )
        }

        return Pair(
            RuntimeEntry(
                key = resolved.key,
                namespace = resolved.namespace,
                value = resolved.value,
                promotedFrom = promotedFrom
            ),
            null
        )
    }

    private fun isSecretReferenceValue(v: Any?): Boolean {
        if (v !is Map<*, *>) return false
        val ref = v["ref"] as? String ?: return false
        if (ref.trim().isEmpty()) return false
        val provider = v["provider"] as? String
        if (provider != null && provider.trim().isEmpty()) return false
        return v.keys.all { it == "provider" || it == "ref" || it == "vault" }
    }

    private fun toSecretReference(v: Any?): SecretReference {
        val map = v as? Map<*, *> ?: throw CnosError("cnos: invalid secret reference")
        val ref = (map["ref"] as? String)?.trim() ?: ""
        if (ref.isEmpty()) throw CnosError("cnos: invalid secret reference")
        return SecretReference(
            ref = ref,
            provider = (map["provider"] as? String)?.trim() ?: "",
            vault = (map["vault"] as? String)?.trim() ?: "",
            envVar = null
        )
    }
}
