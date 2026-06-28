package ai.kitsy.cnos.vault.aws

import ai.kitsy.cnos.SecretVaultProvider
import ai.kitsy.cnos.SecretVaultProviderFactory
import ai.kitsy.cnos.VaultAuthConfig
import ai.kitsy.cnos.VaultDefinition
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.secretsmanager.SecretsManagerClient
import software.amazon.awssdk.services.secretsmanager.model.GetSecretValueRequest

class AwsSecretsManagerProvider(private val vaultId: String, private val def: VaultDefinition) : SecretVaultProvider {
    private var client: SecretsManagerClient? = null

    override fun authenticate(auth: VaultAuthConfig) {
        val region = def.mapping["region"] ?: System.getenv("AWS_DEFAULT_REGION") ?: "us-east-1"
        client = SecretsManagerClient.builder().region(Region.of(region)).build()
    }

    override fun batchGet(refs: List<String>): Map<String, Any> {
        val c = client ?: return emptyMap()
        val out = mutableMapOf<String, Any>()
        for (ref in refs) {
            try {
                val resp = c.getSecretValue(GetSecretValueRequest.builder().secretId(ref).build())
                val value = resp.secretString() ?: continue
                out[ref] = value
            } catch (_: Exception) {}
        }
        return out
    }

    override fun get(ref: String): Any? {
        return batchGet(listOf(ref))[ref]
    }

    companion object {
        fun factory(): SecretVaultProviderFactory = SecretVaultProviderFactory("aws") { vaultId, def ->
            AwsSecretsManagerProvider(vaultId, def)
        }
    }
}
