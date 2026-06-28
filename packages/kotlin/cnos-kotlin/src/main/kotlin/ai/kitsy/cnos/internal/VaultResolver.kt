package ai.kitsy.cnos.internal

import ai.kitsy.cnos.CnosError
import ai.kitsy.cnos.VaultAuthConfig
import ai.kitsy.cnos.VaultDefinition

internal object VaultResolver {

    fun defaultVaultMethod(provider: String): String = when (provider) {
        "local" -> "passphrase"
        "environment", "github-secrets" -> "env"
        "aws" -> "iam"
        "azure" -> "managed-identity"
        "gcp", "firebase" -> "service-account"
        "hashicorp" -> "token"
        else -> "token"
    }

    fun resolveVaultAuth(vaultId: String, definition: VaultDefinition, env: Environment): VaultAuthConfig {
        val auth = definition.auth
        val method = auth.method.ifBlank { defaultVaultMethod(definition.provider) }
        var token = auth.token

        if (token.isNullOrBlank()) {
            val envVarName = "CNOS_VAULT_TOKEN_${vaultId.uppercase().replace('-', '_').replace('.', '_')}"
            token = env.get(envVarName)
        }
        if (token.isNullOrBlank()) {
            token = env.get("VAULT_TOKEN")
        }

        return VaultAuthConfig(
            method = method,
            token = token,
            role = auth.role,
            endpoint = env.get("VAULT_ADDR")
        )
    }

    fun resolveLocalVaultKey(
        @Suppress("UNUSED_PARAMETER") secretHome: String,
        vaultId: String,
        meta: LocalVault.Metadata,
        @Suppress("UNUSED_PARAMETER") definition: VaultDefinition?,
        env: Environment
    ): ByteArray {
        // Try passphrase from env var
        val passphraseEnvVar = "CNOS_VAULT_PASSPHRASE_${vaultId.uppercase().replace('-', '_').replace('.', '_')}"
        val passphrase = env.get(passphraseEnvVar)
            ?: env.get("CNOS_VAULT_PASSPHRASE")
            ?: throw CnosError("cnos: missing vault passphrase for \"$vaultId\" (set $passphraseEnvVar)")
        return LocalVault.deriveKey(passphrase, meta)
    }
}
