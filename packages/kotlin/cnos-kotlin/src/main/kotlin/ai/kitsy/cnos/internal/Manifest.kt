package ai.kitsy.cnos.internal

import ai.kitsy.cnos.ServerProjection
import ai.kitsy.cnos.VaultDefinition

internal data class NamespaceDef(
    val kind: String,
    val runtime: Boolean,
    val shareable: Boolean,
    val sensitive: Boolean,
    val prefix: String?
)

internal data class BootstrappedManifest(
    val namespaces: Map<String, NamespaceDef>,
    val frameworks: Map<String, String>,
    val envMappingExplicit: Map<String, String>,
    val vaults: Map<String, VaultDefinition>
) {
    fun getNamespaceDef(ns: String): NamespaceDef =
        namespaces[ns] ?: NamespaceDef(KIND_DATA, false, true, false, null)

    companion object {
        const val KIND_DATA = "data"

        val DEFAULT_NAMESPACES: Map<String, NamespaceDef> = mapOf(
            "value"  to NamespaceDef(KIND_DATA, false, true,  false, null),
            "secret" to NamespaceDef(KIND_DATA, false, false, true,  null),
            "meta"   to NamespaceDef(KIND_DATA, false, false, false, null),
            "public" to NamespaceDef(KIND_DATA, false, true,  false, null),
            "process" to NamespaceDef(KIND_DATA, true,  false, false, null)
        )

        val DEFAULT_FRAMEWORKS: Map<String, String> = mapOf(
            "next"       to "NEXT_PUBLIC_",
            "vite"       to "VITE_",
            "react"      to "REACT_APP_",
            "gatsby"     to "GATSBY_",
            "expo"       to "EXPO_PUBLIC_",
            "nuxt"       to "NUXT_PUBLIC_",
            "svelte"     to "PUBLIC_",
            "astro"      to "PUBLIC_",
            "angular"    to "NG_APP_",
            "webpack"    to "PUBLIC_"
        )

        fun fromProjection(projection: ServerProjection): BootstrappedManifest {
            val ns = DEFAULT_NAMESPACES.toMutableMap()
            projection.meta.namespaces?.forEach { name ->
                ns.putIfAbsent(name, NamespaceDef(KIND_DATA, false, true, false, null))
            }
            return BootstrappedManifest(ns, DEFAULT_FRAMEWORKS.toMap(), emptyMap(), projection.vaults)
        }
    }
}
