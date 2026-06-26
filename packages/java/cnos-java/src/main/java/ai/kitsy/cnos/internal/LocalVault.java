package ai.kitsy.cnos.internal;

import ai.kitsy.cnos.CnosError;
import com.fasterxml.jackson.databind.ObjectMapper;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.security.spec.KeySpec;
import java.util.Base64;
import java.util.Map;
import java.util.HashMap;

/**
 * Local vault crypto operations: AES-256-GCM decryption and PBKDF2-SHA512 key derivation.
 * Mirrors Go's secrets.go local vault logic.
 */
public final class LocalVault {

    private static final int KEY_LENGTH = 32;
    private static final int IV_LENGTH = 12;
    private static final int AUTH_TAG_LENGTH = 16;
    private static final int KEYSTORE_VERSION = 1;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private LocalVault() {}

    /** Parsed meta.yml fields. */
    public static final class Metadata {
        public final int version;
        public final String algorithm;
        public final String kdf;
        public final int iterations;
        public final String salt;

        public Metadata(int version, String algorithm, String kdf, int iterations, String salt) {
            this.version = version;
            this.algorithm = algorithm;
            this.kdf = kdf;
            this.iterations = iterations;
            this.salt = salt;
        }
    }

    /**
     * Parses the {@code meta.yml} file for a local vault.
     * Uses simple KEY: VALUE line parsing (not full YAML).
     *
     * @param data raw bytes of meta.yml
     * @return parsed metadata
     * @throws CnosError if the metadata is missing or invalid
     */
    public static Metadata parseMetadata(byte[] data) throws CnosError {
        Map<String, String> values = new HashMap<>();
        for (String raw : new String(data).split("\\n")) {
            String line = raw.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            int colon = line.indexOf(':');
            if (colon < 0) continue;
            String key = line.substring(0, colon).trim();
            String value = line.substring(colon + 1).trim().replaceAll("^[\"']|[\"']$", "");
            values.put(key, value);
        }

        try {
            int version = Integer.parseInt(values.getOrDefault("version", ""));
            int iterations = Integer.parseInt(values.getOrDefault("iterations", ""));
            String algorithm = values.getOrDefault("algorithm", "");
            String kdf = values.getOrDefault("kdf", "");
            String salt = values.getOrDefault("salt", "");

            if (version != 1 || !"aes-256-gcm".equals(algorithm) || !"pbkdf2-sha512".equals(kdf) || salt.isEmpty()) {
                throw new CnosError("cnos: invalid CNOS vault metadata");
            }
            return new Metadata(version, algorithm, kdf, iterations, salt);
        } catch (NumberFormatException e) {
            throw new CnosError("cnos: invalid CNOS vault metadata");
        }
    }

    /**
     * Derives an AES-256 key from a passphrase using PBKDF2-SHA512.
     *
     * @param passphrase the user passphrase
     * @param saltBase64 base64-encoded salt
     * @param iterations PBKDF2 iteration count
     * @return 32-byte derived key
     * @throws CnosError if the salt is invalid
     */
    public static byte[] deriveKey(String passphrase, String saltBase64, int iterations) throws CnosError {
        byte[] salt;
        try {
            salt = Base64.getDecoder().decode(saltBase64);
        } catch (IllegalArgumentException e) {
            throw new CnosError("cnos: invalid salt for local vault");
        }
        return pbkdf2Sha512(passphrase.getBytes(java.nio.charset.StandardCharsets.UTF_8), salt, iterations, KEY_LENGTH);
    }

    /**
     * Decrypts the {@code keystore.enc} binary payload.
     * Binary format: [4-byte LE int version=1][12-byte IV][16-byte auth tag][ciphertext]
     *
     * @param buffer  raw keystore bytes
     * @param key     32-byte AES key
     * @return map of secret name → value
     * @throws CnosError if decryption fails or format is invalid
     */
    public static Map<String, String> decryptKeystore(byte[] buffer, byte[] key) throws CnosError {
        if (buffer.length < 4 + IV_LENGTH + AUTH_TAG_LENGTH) {
            throw new CnosError("cnos: invalid CNOS local vault keystore");
        }

        ByteBuffer bb = ByteBuffer.wrap(buffer, 0, 4).order(ByteOrder.LITTLE_ENDIAN);
        int version = bb.getInt();
        if (version != KEYSTORE_VERSION) {
            throw new CnosError("cnos: unsupported CNOS local vault keystore version: " + version);
        }

        byte[] iv = new byte[IV_LENGTH];
        byte[] tag = new byte[AUTH_TAG_LENGTH];
        System.arraycopy(buffer, 4, iv, 0, IV_LENGTH);
        System.arraycopy(buffer, 4 + IV_LENGTH, tag, 0, AUTH_TAG_LENGTH);

        int cipherLen = buffer.length - 4 - IV_LENGTH - AUTH_TAG_LENGTH;
        byte[] ciphertext = new byte[cipherLen];
        System.arraycopy(buffer, 4 + IV_LENGTH + AUTH_TAG_LENGTH, ciphertext, 0, cipherLen);

        byte[] plaintext = decryptAesGcm(key, iv, ciphertext, tag);
        if (plaintext == null) {
            throw new CnosError("cnos: failed to decrypt CNOS local vault. Check vault authentication");
        }

        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> doc = MAPPER.readValue(plaintext, Map.class);
            Object secretsObj = doc.get("secrets");
            if (!(secretsObj instanceof Map)) {
                throw new CnosError("cnos: failed to decrypt CNOS local vault. Check vault authentication");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> secretsRaw = (Map<String, Object>) secretsObj;
            Map<String, String> secrets = new HashMap<>();
            for (Map.Entry<String, Object> entry : secretsRaw.entrySet()) {
                if (entry.getValue() instanceof String) {
                    secrets.put(entry.getKey(), (String) entry.getValue());
                }
            }
            return secrets;
        } catch (IOException e) {
            throw new CnosError("cnos: failed to decrypt CNOS local vault. Check vault authentication");
        }
    }

    /**
     * Decrypts a session-encrypted secrets payload from env vars.
     * Payload JSON: {@code {"iv":"base64","tag":"base64","ciphertext":"base64"}}
     *
     * @param sessionKeyHex hex-encoded 32-byte AES session key
     * @param payloadJson   JSON string of the encrypted payload
     * @return decrypted JSON bytes
     * @throws CnosError on invalid key, malformed JSON, or decryption failure
     */
    public static byte[] decryptSessionPayload(String sessionKeyHex, String payloadJson) throws CnosError {
        byte[] key;
        try {
            key = hexDecode(sessionKeyHex);
        } catch (IllegalArgumentException e) {
            throw new CnosError("cnos: invalid session key for encrypted secret payload");
        }
        if (key.length != KEY_LENGTH) {
            throw new CnosError("cnos: invalid session key for encrypted secret payload");
        }

        Map<?, ?> payload;
        try {
            payload = MAPPER.readValue(payloadJson, Map.class);
        } catch (IOException e) {
            throw new CnosError("cnos: parse encrypted secret payload: " + e.getMessage(), e);
        }

        String ivB64 = (String) payload.get("iv");
        String tagB64 = (String) payload.get("tag");
        String ciphertextB64 = (String) payload.get("ciphertext");

        byte[] iv = Base64.getDecoder().decode(ivB64);
        byte[] tag = Base64.getDecoder().decode(tagB64);
        byte[] ciphertext = Base64.getDecoder().decode(ciphertextB64);

        byte[] plaintext = decryptAesGcm(key, iv, ciphertext, tag);
        if (plaintext == null) {
            throw new CnosError("cnos: failed to decrypt session secrets payload");
        }
        return plaintext;
    }

    /**
     * AES-256-GCM decryption. Returns null on auth failure (wrong key / corrupt data).
     * The tag is appended to the ciphertext before passing to the JCE GCM cipher.
     */
    public static byte[] decryptAesGcm(byte[] key, byte[] iv, byte[] ciphertext, byte[] tag) {
        try {
            // JCE GCM requires ciphertext + tag concatenated
            byte[] combined = new byte[ciphertext.length + tag.length];
            System.arraycopy(ciphertext, 0, combined, 0, ciphertext.length);
            System.arraycopy(tag, 0, combined, ciphertext.length, tag.length);

            SecretKey secretKey = new SecretKeySpec(key, "AES");
            GCMParameterSpec paramSpec = new GCMParameterSpec(AUTH_TAG_LENGTH * 8, iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey, paramSpec);
            return cipher.doFinal(combined);
        } catch (GeneralSecurityException e) {
            return null;
        }
    }

    /**
     * PBKDF2-SHA512 key derivation — matches Go's manual implementation exactly.
     */
    public static byte[] pbkdf2Sha512(byte[] password, byte[] salt, int iterations, int keyLen) {
        int hLen = 64; // SHA-512 output length
        int blockCount = (keyLen + hLen - 1) / hLen;
        byte[] result = new byte[blockCount * hLen];

        for (int block = 1; block <= blockCount; block++) {
            byte[] u = pbkdf2Block(password, salt, iterations, block);
            System.arraycopy(u, 0, result, (block - 1) * hLen, hLen);
        }
        byte[] truncated = new byte[keyLen];
        System.arraycopy(result, 0, truncated, 0, keyLen);
        return truncated;
    }

    private static byte[] pbkdf2Block(byte[] password, byte[] salt, int iterations, int blockNum) {
        try {
            Mac mac = Mac.getInstance("HmacSHA512");
            mac.init(new SecretKeySpec(password, "HmacSHA512"));

            // First PRF call: HMAC(password, salt || INT(blockNum))
            mac.update(salt);
            byte[] blockNumBytes = ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN).putInt(blockNum).array();
            mac.update(blockNumBytes);
            byte[] u = mac.doFinal();
            byte[] out = u.clone();

            for (int step = 1; step < iterations; step++) {
                mac.reset();
                mac.init(new SecretKeySpec(password, "HmacSHA512"));
                mac.update(u);
                u = mac.doFinal();
                for (int i = 0; i < out.length; i++) {
                    out[i] ^= u[i];
                }
            }
            return out;
        } catch (GeneralSecurityException e) {
            throw new RuntimeException("PBKDF2-SHA512 failed", e);
        }
    }

    public static byte[] hexDecode(String hex) {
        if (hex == null || hex.length() % 2 != 0) {
            throw new IllegalArgumentException("hex string must have even length");
        }
        int len = hex.length();
        byte[] data = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            int high = Character.digit(hex.charAt(i), 16);
            int low = Character.digit(hex.charAt(i + 1), 16);
            if (high == -1 || low == -1) {
                throw new IllegalArgumentException("invalid hex character at position " + i);
            }
            data[i / 2] = (byte) ((high << 4) + low);
        }
        return data;
    }

    /**
     * Reads the vault keystore file and returns decrypted secrets.
     *
     * @param secretHome base secrets directory
     * @param vaultId    vault identifier
     * @param key        derived AES key
     * @return decrypted secrets map
     * @throws CnosError on I/O or crypto failure
     */
    public static Map<String, String> readVaultSecrets(String secretHome, String vaultId, byte[] key) throws CnosError {
        File keystoreFile = new File(secretHome, "vaults/" + vaultId + "/keystore.enc");
        byte[] buffer;
        try {
            buffer = Files.readAllBytes(keystoreFile.toPath());
        } catch (IOException e) {
            throw new CnosError("cnos: read local vault keystore for \"" + vaultId + "\": " + e.getMessage(), e);
        }
        return decryptKeystore(buffer, key);
    }
}
