package ai.kitsy.cnos.vault.hashicorp

import ai.kitsy.cnos.SecretVaultProvider
import ai.kitsy.cnos.SecretVaultProviderFactory
import ai.kitsy.cnos.VaultAuthConfig
import ai.kitsy.cnos.VaultDefinition
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import java.net.HttpURLConnection
import java.net.URL

class HashicorpVaultProvider(private val vaultId: String, private val def: VaultDefinition) : SecretVaultProvider {
    private var token: String? = null
    private val addr: String = def.mapping["addr"]
        ?: System.getenv("VAULT_ADDR") ?: "http://127.0.0.1:8200"
    private val mount: String = def.mapping["mount"] ?: "secret"
    private val mapper = jacksonObjectMapper()

    override fun authenticate(auth: VaultAuthConfig) {
        token = auth.token ?: System.getenv("VAULT_TOKEN")
    }

    override fun batchGet(refs: List<String>): Map<String, Any> {
        val out = mutableMapOf<String, Any>()
        for (ref in refs) {
            try {
                val (path, field) = parseRef(ref)
                val url = "$addr/v1/$mount/data/$path"
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                if (!token.isNullOrEmpty()) conn.setRequestProperty("X-Vault-Token", token)
                conn.connect()
                if (conn.responseCode == 200) {
                    val body = conn.inputStream.bufferedReader().readText()
                    val parsed = mapper.readValue<Map<String, Any>>(body)
                    @Suppress("UNCHECKED_CAST")
                    val data = (parsed["data"] as? Map<String, Any>)?.get("data") as? Map<String, Any>
                        ?: continue
                    val value = if (!field.isNullOrEmpty()) data[field] else data.values.firstOrNull()
                    if (value != null) out[ref] = value
                }
            } catch (_: Exception) {}
        }
        return out
    }

    override fun get(ref: String): Any? = batchGet(listOf(ref))[ref]

    private fun parseRef(ref: String): Pair<String, String?> {
        val idx = ref.indexOf('#')
        return if (idx >= 0) Pair(ref.substring(0, idx), ref.substring(idx + 1)) else Pair(ref, null)
    }

    companion object {
        fun factory(): SecretVaultProviderFactory = SecretVaultProviderFactory("hashicorp") { vaultId, def ->
            HashicorpVaultProvider(vaultId, def)
        }
    }
}
