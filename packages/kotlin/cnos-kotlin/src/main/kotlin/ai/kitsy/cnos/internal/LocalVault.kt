package ai.kitsy.cnos.internal

import ai.kitsy.cnos.CnosError
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.spec.KeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

internal object LocalVault {

    data class Metadata(val salt: ByteArray, val iterations: Int, val kdf: String)

    fun parseMetadata(data: ByteArray): Metadata {
        val lines = String(data, Charsets.UTF_8).lines()
        val map = mutableMapOf<String, String>()
        for (line in lines) {
            val idx = line.indexOf(':')
            if (idx > 0) map[line.substring(0, idx).trim()] = line.substring(idx + 1).trim()
        }
        val salt = Base64.getDecoder().decode(map["salt"] ?: throw CnosError("cnos: vault meta missing salt"))
        val iterations = map["iterations"]?.toIntOrNull() ?: 100_000
        val kdf = map["kdf"] ?: "pbkdf2-sha512"
        return Metadata(salt, iterations, kdf)
    }

    fun deriveKey(passphrase: String, meta: Metadata): ByteArray {
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA512")
        val spec: KeySpec = PBEKeySpec(passphrase.toCharArray(), meta.salt, meta.iterations, 256)
        return factory.generateSecret(spec).encoded
    }

    fun readVaultSecrets(secretHome: String, vaultId: String, key: ByteArray): Map<String, String> {
        val encFile = File(secretHome, "vaults/$vaultId/keystore.enc")
        if (!encFile.isFile) throw CnosError("cnos: missing vault keystore for \"$vaultId\"")
        val raw = encFile.readBytes()

        // Layout: 4-byte LE version | 12-byte IV | 16-byte tag (appended by AES-GCM) | ciphertext
        if (raw.size < 16) throw CnosError("cnos: vault keystore too small")
        val buf = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN)
        val version = buf.int
        if (version != 1) throw CnosError("cnos: unsupported vault keystore version $version")
        val iv = ByteArray(12).also { buf.get(it) }
        val rest = ByteArray(raw.size - 16).also { buf.get(it) }

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val keySpec = SecretKeySpec(key, "AES")
        cipher.init(Cipher.DECRYPT_MODE, keySpec, GCMParameterSpec(128, iv))
        val plaintext = cipher.doFinal(rest)

        val text = String(plaintext, Charsets.UTF_8)
        val secrets = mutableMapOf<String, String>()
        for (line in text.lines()) {
            val idx = line.indexOf('=')
            if (idx > 0) secrets[line.substring(0, idx).trim()] = line.substring(idx + 1)
        }
        return secrets
    }

    fun decryptSessionPayload(sessionKeyHex: String, payloadBase64: String): ByteArray {
        val key = hexDecode(sessionKeyHex)
        val data = Base64.getDecoder().decode(payloadBase64)
        if (data.size < 12) throw CnosError("cnos: encrypted secret payload too small")
        val iv = data.copyOfRange(0, 12)
        val body = data.copyOfRange(12, data.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        return cipher.doFinal(body)
    }

    private fun hexDecode(s: String): ByteArray {
        val len = s.length
        val out = ByteArray(len / 2)
        for (i in 0 until len / 2) {
            out[i] = (s[i * 2].digitToInt(16) shl 4 or s[i * 2 + 1].digitToInt(16)).toByte()
        }
        return out
    }
}
