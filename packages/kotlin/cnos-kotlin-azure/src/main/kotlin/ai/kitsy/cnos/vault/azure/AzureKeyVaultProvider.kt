package ai.kitsy.cnos.vault.azure

import ai.kitsy.cnos.SecretVaultProvider
import ai.kitsy.cnos.SecretVaultProviderFactory
import ai.kitsy.cnos.VaultAuthConfig
import ai.kitsy.cnos.VaultDefinition
import com.azure.identity.DefaultAzureCredentialBuilder
import com.azure.security.keyvault.secrets.SecretClient
import com.azure.security.keyvault.secrets.SecretClientBuilder

class AzureKeyVaultProvider(private val vaultId: String, private val def: VaultDefinition) : SecretVaultProvider {
    private var client: SecretClient? = null

    override fun authenticate(auth: VaultAuthConfig) {
        val vaultUrl = def.mapping["vaultUrl"]
            ?: System.getenv("AZURE_KEYVAULT_URL")
            ?: "https://$vaultId.vault.azure.net"
        client = SecretClientBuilder()
            .vaultUrl(vaultUrl)
            .credential(DefaultAzureCredentialBuilder().build())
            .buildClient()
    }

    override fun batchGet(refs: List<String>): Map<String, Any> {
        val c = client ?: return emptyMap()
        val out = mutableMapOf<String, Any>()
        for (ref in refs) {
            try {
                // Azure Key Vault does not allow dots in secret names
                val name = ref.replace('.', '-')
                val secret = c.getSecret(name)
                out[ref] = secret.value
            } catch (_: Exception) {}
        }
        return out
    }

    override fun get(ref: String): Any? = batchGet(listOf(ref))[ref]

    companion object {
        fun factory(): SecretVaultProviderFactory = SecretVaultProviderFactory("azure") { vaultId, def ->
            AzureKeyVaultProvider(vaultId, def)
        }
    }
}
