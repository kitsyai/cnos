using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Kitsy.Cnos;

namespace Kitsy.Cnos.Internal
{
    /// <summary>
    /// Local vault crypto: AES-256-GCM decryption and PBKDF2-SHA512 key derivation.
    /// Mirrors Go's secrets.go local vault logic.
    /// </summary>
    internal static class LocalVault
    {
        private const int KeyLength = 32;
        private const int IvLength = 12;
        private const int AuthTagLength = 16;

        public sealed class Metadata
        {
            public int Version { get; }
            public string Algorithm { get; }
            public string Kdf { get; }
            public int Iterations { get; }
            public string Salt { get; }

            public Metadata(int version, string algorithm, string kdf, int iterations, string salt)
            {
                Version = version; Algorithm = algorithm; Kdf = kdf; Iterations = iterations; Salt = salt;
            }
        }

        public static Metadata ParseMetadata(byte[] data)
        {
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var raw in Encoding.UTF8.GetString(data).Split('\n'))
            {
                string line = raw.Trim();
                if (string.IsNullOrEmpty(line) || line.StartsWith("#")) continue;
                int colon = line.IndexOf(':');
                if (colon < 0) continue;
                string k = line.Substring(0, colon).Trim();
                string v = line.Substring(colon + 1).Trim().Trim('"', '\'');
                values[k] = v;
            }

            if (!int.TryParse(values.GetValueOrDefault("version", ""), out int version) || version != 1)
                throw new CnosError("cnos: unsupported vault metadata version");
            if (!int.TryParse(values.GetValueOrDefault("iterations", ""), out int iterations) || iterations < 1)
                throw new CnosError("cnos: invalid vault metadata: iterations");
            string algorithm = values.GetValueOrDefault("algorithm", "");
            string kdf = values.GetValueOrDefault("kdf", "");
            string salt = values.GetValueOrDefault("salt", "");

            if (algorithm != "aes-256-gcm" || kdf != "pbkdf2-sha512" || string.IsNullOrEmpty(salt))
                throw new CnosError("cnos: unsupported vault encryption format");

            return new Metadata(version, algorithm, kdf, iterations, salt);
        }

        public static byte[] DeriveKey(string passphrase, string salt, int iterations)
        {
            byte[] saltBytes = Encoding.UTF8.GetBytes(salt);
            using var deriveBytes = new Rfc2898DeriveBytes(
                passphrase, saltBytes, iterations, HashAlgorithmName.SHA512);
            return deriveBytes.GetBytes(KeyLength);
        }

        public static Dictionary<string, string> ReadVaultSecrets(string secretHome, string vaultId, byte[] key)
        {
            string storePath = Path.Combine(secretHome, "vaults", vaultId, "store.enc");
            if (!File.Exists(storePath))
                return new Dictionary<string, string>(StringComparer.Ordinal);

            byte[] ciphertext = File.ReadAllBytes(storePath);
            byte[] plaintext = DecryptAesGcm(ciphertext, key);

            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            try
            {
                using var doc = JsonDocument.Parse(plaintext);
                foreach (var prop in doc.RootElement.EnumerateObject())
                {
                    if (prop.Value.ValueKind == JsonValueKind.String)
                        result[prop.Name] = prop.Value.GetString() ?? "";
                }
            }
            catch (Exception ex)
            {
                throw new CnosError("cnos: decode vault store for \"" + vaultId + "\": " + ex.Message, ex);
            }
            return result;
        }

        public static byte[] DecryptSessionPayload(string sessionKeyHex, string payloadBase64)
        {
            byte[] key = HexDecode(sessionKeyHex);
            byte[] ciphertext = Convert.FromBase64String(payloadBase64);
            return DecryptAesGcm(ciphertext, key);
        }

        private static byte[] DecryptAesGcm(byte[] ciphertext, byte[] key)
        {
            if (ciphertext.Length < IvLength + AuthTagLength)
                throw new CnosError("cnos: vault ciphertext too short");

            byte[] iv = new byte[IvLength];
            Array.Copy(ciphertext, 0, iv, 0, IvLength);

            int cLen = ciphertext.Length - IvLength - AuthTagLength;
            byte[] encData = new byte[cLen];
            Array.Copy(ciphertext, IvLength, encData, 0, cLen);

            byte[] tag = new byte[AuthTagLength];
            Array.Copy(ciphertext, IvLength + cLen, tag, 0, AuthTagLength);

            byte[] plaintext = new byte[cLen];

            using var aes = new AesGcm(key);
            aes.Decrypt(iv, encData, tag, plaintext);
            return plaintext;
        }

        public static byte[] HexDecode(string hex)
        {
            if (hex.Length % 2 != 0)
                throw new ArgumentException("Hex string must have even length");
            byte[] bytes = new byte[hex.Length / 2];
            for (int i = 0; i < bytes.Length; i++)
                bytes[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
            return bytes;
        }
    }
}
