package ai.kitsy.cnos.vault.gcp

import ai.kitsy.cnos.SecretVaultProvider
import ai.kitsy.cnos.SecretVaultProviderFactory
import ai.kitsy.cnos.VaultAuthConfig
import ai.kitsy.cnos.VaultDefinition
import java.net.HttpURLConnection
import java.net.URL

class GcpSecretManagerProvider(private val vaultId: String, private val def: VaultDefinition) : SecretVaultProvider {
    private var token: String? = null
    private val projectId: String = def.mapping["project"] ?: System.getenv("GOOGLE_CLOUD_PROJECT") ?: ""

    override fun authenticate(auth: VaultAuthConfig) {
        token = auth.token
        if (token.isNullOrEmpty()) {
            token = fetchMetadataToken()
        }
    }

    override fun batchGet(refs: List<String>): Map<String, Any> {
        val out = mutableMapOf<String, Any>()
        for (ref in refs) {
            try {
                // GCP does not allow dots in secret names
                val name = ref.replace('.', '_')
                val url = "https://secretmanager.googleapis.com/v1/projects/$projectId/secrets/$name/versions/latest:access"
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                if (!token.isNullOrEmpty()) conn.setRequestProperty("Authorization", "Bearer $token")
                conn.connect()
                if (conn.responseCode == 200) {
                    val body = conn.inputStream.bufferedReader().readText()
                    val match = Regex(""""data"\s*:\s*"([^"]+)"""").find(body)
                    if (match != null) {
                        val decoded = java.util.Base64.getDecoder().decode(match.groupValues[1])
                        out[ref] = String(decoded, Charsets.UTF_8)
                    }
                }
            } catch (_: Exception) {}
        }
        return out
    }

    override fun get(ref: String): Any? = batchGet(listOf(ref))[ref]

    private fun fetchMetadataToken(): String? {
        return try {
            val url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.setRequestProperty("Metadata-Flavor", "Google")
            conn.connect()
            if (conn.responseCode == 200) {
                val body = conn.inputStream.bufferedReader().readText()
                Regex(""""access_token"\s*:\s*"([^"]+)"""").find(body)?.groupValues?.get(1)
            } else null
        } catch (_: Exception) { null }
    }

    companion object {
        fun factory(): SecretVaultProviderFactory = SecretVaultProviderFactory("gcp") { vaultId, def ->
            GcpSecretManagerProvider(vaultId, def)
        }
    }
}
