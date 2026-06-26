package ai.kitsy.cnos;

import ai.kitsy.cnos.internal.LocalVault;
import org.junit.jupiter.api.Test;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class LocalVaultTest {

    // ---- PBKDF2 key derivation ----

    @Test
    void pbkdf2Sha512ProducesCorrectLength() {
        byte[] password = "passphrase".getBytes(StandardCharsets.UTF_8);
        byte[] salt = "saltsalt".getBytes(StandardCharsets.UTF_8);
        byte[] key = LocalVault.pbkdf2Sha512(password, salt, 10, 32);
        assertNotNull(key);
        assertEquals(32, key.length);
    }

    @Test
    void pbkdf2Sha512DeterministicOutput() {
        byte[] password = "passphrase".getBytes(StandardCharsets.UTF_8);
        byte[] salt = Base64.getDecoder().decode("aGVsbG8="); // "hello"
        byte[] key1 = LocalVault.pbkdf2Sha512(password, salt, 100, 32);
        byte[] key2 = LocalVault.pbkdf2Sha512(password, salt, 100, 32);
        assertArrayEquals(key1, key2);
    }

    @Test
    void pbkdf2Sha512DifferentIterationsProduceDifferentKeys() {
        byte[] password = "passphrase".getBytes(StandardCharsets.UTF_8);
        byte[] salt = "saltsalt".getBytes(StandardCharsets.UTF_8);
        byte[] key1 = LocalVault.pbkdf2Sha512(password, salt, 100, 32);
        byte[] key2 = LocalVault.pbkdf2Sha512(password, salt, 200, 32);
        assertFalse(java.util.Arrays.equals(key1, key2));
    }

    // ---- AES-256-GCM decrypt ----

    @Test
    void aesGcmRoundTrip() throws Exception {
        byte[] key = new byte[32];
        new SecureRandom().nextBytes(key);
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);
        byte[] plaintext = "{\"secrets\":{\"MY_KEY\":\"MY_VALUE\"}}".getBytes(StandardCharsets.UTF_8);

        // Encrypt
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        byte[] combined = cipher.doFinal(plaintext);

        // Split ciphertext and tag (last 16 bytes are tag)
        byte[] ciphertext = new byte[combined.length - 16];
        byte[] tag = new byte[16];
        System.arraycopy(combined, 0, ciphertext, 0, ciphertext.length);
        System.arraycopy(combined, ciphertext.length, tag, 0, 16);

        // Decrypt
        byte[] decrypted = LocalVault.decryptAesGcm(key, iv, ciphertext, tag);
        assertNotNull(decrypted);
        assertEquals(new String(plaintext, StandardCharsets.UTF_8), new String(decrypted, StandardCharsets.UTF_8));
    }

    @Test
    void aesGcmWrongKeyReturnsNull() throws Exception {
        byte[] key = new byte[32];
        new SecureRandom().nextBytes(key);
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);
        byte[] plaintext = "hello".getBytes(StandardCharsets.UTF_8);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        byte[] combined = cipher.doFinal(plaintext);
        byte[] ciphertext = new byte[combined.length - 16];
        byte[] tag = new byte[16];
        System.arraycopy(combined, 0, ciphertext, 0, ciphertext.length);
        System.arraycopy(combined, ciphertext.length, tag, 0, 16);

        byte[] wrongKey = new byte[32];
        new SecureRandom().nextBytes(wrongKey);
        byte[] result = LocalVault.decryptAesGcm(wrongKey, iv, ciphertext, tag);
        assertNull(result);
    }

    // ---- Keystore binary format ----

    @Test
    void decryptKeystoreRoundTrip() throws Exception {
        byte[] key = new byte[32];
        new SecureRandom().nextBytes(key);
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);

        String payload = "{\"secrets\":{\"MY_SECRET\":\"top-secret-value\"}}";
        byte[] plaintext = payload.getBytes(StandardCharsets.UTF_8);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        byte[] combined = cipher.doFinal(plaintext);

        // Build keystore binary: [4-byte LE version=1][12-byte IV][16-byte tag][ciphertext]
        byte[] tag = new byte[16];
        System.arraycopy(combined, combined.length - 16, tag, 0, 16);
        byte[] ciphertext = new byte[combined.length - 16];
        System.arraycopy(combined, 0, ciphertext, 0, ciphertext.length);

        ByteBuffer buf = ByteBuffer.allocate(4 + 12 + 16 + ciphertext.length).order(ByteOrder.LITTLE_ENDIAN);
        buf.putInt(1); // version
        buf.put(iv);
        buf.put(tag);
        buf.put(ciphertext);

        Map<String, String> secrets = LocalVault.decryptKeystore(buf.array(), key);
        assertNotNull(secrets);
        assertEquals("top-secret-value", secrets.get("MY_SECRET"));
    }

    @Test
    void decryptKeystoreWrongVersionThrows() {
        byte[] wrongVersion = new byte[4 + 12 + 16 + 10];
        ByteBuffer.wrap(wrongVersion).order(ByteOrder.LITTLE_ENDIAN).putInt(99);
        assertThrows(CnosError.class, () -> LocalVault.decryptKeystore(wrongVersion, new byte[32]));
    }

    @Test
    void decryptKeystoreTooShortThrows() {
        byte[] tooShort = new byte[10];
        assertThrows(CnosError.class, () -> LocalVault.decryptKeystore(tooShort, new byte[32]));
    }

    // ---- Metadata parsing ----

    @Test
    void parseValidMetadata() throws CnosError {
        String meta = "version: 1\nalgorithm: aes-256-gcm\nkdf: pbkdf2-sha512\niterations: 600000\nsalt: aGVsbG8=\n";
        LocalVault.Metadata m = LocalVault.parseMetadata(meta.getBytes(StandardCharsets.UTF_8));
        assertEquals(1, m.version);
        assertEquals("aes-256-gcm", m.algorithm);
        assertEquals("pbkdf2-sha512", m.kdf);
        assertEquals(600000, m.iterations);
        assertEquals("aGVsbG8=", m.salt);
    }

    @Test
    void parseMetadataWrongVersionThrows() {
        String meta = "version: 2\nalgorithm: aes-256-gcm\nkdf: pbkdf2-sha512\niterations: 100\nsalt: abc\n";
        assertThrows(CnosError.class, () -> LocalVault.parseMetadata(meta.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void parseMetadataWrongAlgorithmThrows() {
        String meta = "version: 1\nalgorithm: aes-128-gcm\nkdf: pbkdf2-sha512\niterations: 100\nsalt: abc\n";
        assertThrows(CnosError.class, () -> LocalVault.parseMetadata(meta.getBytes(StandardCharsets.UTF_8)));
    }

    // ---- Session decrypt ----

    @Test
    void decryptSessionPayloadRoundTrip() throws Exception {
        byte[] key = new byte[32];
        new SecureRandom().nextBytes(key);
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);

        String content = "{\"secret.db.pass\":\"my-secret\"}";
        byte[] plaintext = content.getBytes(StandardCharsets.UTF_8);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        byte[] combined = cipher.doFinal(plaintext);

        byte[] tag = new byte[16];
        System.arraycopy(combined, combined.length - 16, tag, 0, 16);
        byte[] ciphertext = new byte[combined.length - 16];
        System.arraycopy(combined, 0, ciphertext, 0, ciphertext.length);

        String keyHex = bytesToHex(key);
        String payloadJson = "{\"iv\":\"" + Base64.getEncoder().encodeToString(iv) + "\","
                + "\"tag\":\"" + Base64.getEncoder().encodeToString(tag) + "\","
                + "\"ciphertext\":\"" + Base64.getEncoder().encodeToString(ciphertext) + "\"}";

        byte[] decrypted = LocalVault.decryptSessionPayload(keyHex, payloadJson);
        assertEquals(content, new String(decrypted, StandardCharsets.UTF_8));
    }

    @Test
    void decryptSessionPayloadInvalidKeyThrows() {
        assertThrows(CnosError.class, () ->
                LocalVault.decryptSessionPayload("not-hex", "{\"iv\":\"\",\"tag\":\"\",\"ciphertext\":\"\"}"));
    }

    private static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
