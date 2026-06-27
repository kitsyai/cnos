using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Kitsy.Cnos;

namespace Kitsy.Cnos.Internal
{
    internal static class VaultResolver
    {
        private const int KeyLength = 32;

        public static VaultAuthConfig ResolveVaultAuth(string vaultId, VaultDefinition definition,
            CnosEnvironment env)
        {
            VaultAuth? auth = definition.Auth;
            string method = auth?.Method?.Trim() ?? "";
            if (string.IsNullOrEmpty(method))
                method = DefaultVaultMethod(definition.Provider);

            var config = auth?.Config;

            switch (method)
            {
                case "iam":
                case "environment":
                    return VaultAuthConfig.OfMethod(method, config);
                case "token":
                {
                    string? token = ResolveFirstSource(auth?.Token, env);
                    if (token == null) throw VaultAuthError(vaultId, auth?.Token);
                    return VaultAuthConfig.OfToken(token, config);
                }
            }

            // Fallback: try token sources, then passphrase sources
            if (auth?.Token?.From?.Count > 0)
            {
                string? token = ResolveFirstSource(auth.Token, env);
                if (token != null) return VaultAuthConfig.OfToken(token, config);
            }

            if (auth?.Passphrase?.From?.Count > 0)
            {
                string? passphrase = ResolveFirstSource(auth.Passphrase, env);
                if (passphrase != null) return VaultAuthConfig.OfPassphrase(passphrase, config);
                throw VaultAuthError(vaultId, auth.Passphrase);
            }

            string? pp = ResolveVaultPassphrase(vaultId, env);
            if (pp != null) return VaultAuthConfig.OfPassphrase(pp, config);

            return VaultAuthConfig.OfMethod(method, config);
        }

        public static byte[] ResolveLocalVaultKey(string secretHome, string vaultId,
            LocalVault.Metadata meta, VaultDefinition? definition, CnosEnvironment env)
        {
            // 1. Session key env var
            string sessionKeyVar = GetVaultSessionKeyEnvVar(vaultId);
            string? preKey = env.Get(sessionKeyVar);
            if (!string.IsNullOrEmpty(preKey))
            {
                try
                {
                    byte[] k = LocalVault.HexDecode(preKey);
                    if (k.Length == KeyLength) return k;
                }
                catch { }
            }

            // 2. Session file
            string sessionFile = Path.Combine(secretHome, "sessions", vaultId + ".json");
            if (File.Exists(sessionFile))
            {
                byte[]? sk = ReadSessionKey(sessionFile);
                if (sk != null) return sk;
            }

            // 3. Auth sources
            foreach (string source in ResolveLocalVaultAuthSources(vaultId, definition))
            {
                if (source.StartsWith("env:", StringComparison.Ordinal))
                {
                    string? pp = env.Get(source.Substring(4));
                    if (!string.IsNullOrEmpty(pp))
                        return LocalVault.DeriveKey(pp!, meta.Salt, meta.Iterations);
                }
                else if (source == "prompt")
                {
                    // Interactive prompt when running in a terminal
                    if (System.Console.IsInputRedirected) continue;
                    System.Console.Write($"Enter passphrase for vault \"{vaultId}\": ");
                    string? pp = ReadPassword();
                    if (!string.IsNullOrEmpty(pp))
                        return LocalVault.DeriveKey(pp!, meta.Salt, meta.Iterations);
                }
            }

            // 4. Fallback env var
            string? fallback = ResolveVaultPassphrase(vaultId, env);
            if (fallback != null)
                return LocalVault.DeriveKey(fallback, meta.Salt, meta.Iterations);

            var tried = new List<string> { sessionKeyVar };
            tried.AddRange(ResolveLocalVaultAuthSources(vaultId, definition));
            throw new CnosError(
                $"cnos: cannot authenticate to vault \"{vaultId}\". " +
                $"Tried: {string.Join(", ", tried)}. " +
                $"Set {GetVaultPassphraseEnvVar(vaultId)} or run cnos vault auth {vaultId}");
        }

        public static List<string> ResolveLocalVaultAuthSources(string vaultId, VaultDefinition? definition)
        {
            if (definition?.Auth?.Passphrase?.From?.Count > 0)
                return new List<string>(definition.Auth.Passphrase.From);

            string token = NormalizeVaultToken(vaultId);
            var sources = new List<string>();
            if (!string.IsNullOrEmpty(token))
                sources.Add("env:CNOS_SECRET_PASSPHRASE_" + token);
            sources.Add("env:CNOS_SECRET_PASSPHRASE");
            sources.Add("keychain:cnos/" + vaultId);
            sources.Add("prompt");
            return sources;
        }

        public static string? ResolveVaultPassphrase(string vaultId, CnosEnvironment env)
        {
            string? specific = env.Get(GetVaultPassphraseEnvVar(vaultId));
            if (!string.IsNullOrEmpty(specific)) return specific;
            string? fallback = env.Get("CNOS_SECRET_PASSPHRASE");
            if (!string.IsNullOrEmpty(fallback)) return fallback;
            return null;
        }

        public static string GetVaultPassphraseEnvVar(string vaultId)
        {
            string token = NormalizeVaultToken(vaultId);
            if (!string.IsNullOrEmpty(token) && token != "DEFAULT")
                return "CNOS_SECRET_PASSPHRASE_" + token;
            return "CNOS_SECRET_PASSPHRASE";
        }

        public static string GetVaultSessionKeyEnvVar(string vaultId)
        {
            string token = NormalizeVaultToken(vaultId);
            if (string.IsNullOrEmpty(token)) token = "DEFAULT";
            return $"__CNOS_VAULT_KEY_{token}__";
        }

        public static string NormalizeVaultToken(string? vaultId)
        {
            if (string.IsNullOrEmpty(vaultId)) return "";
            var sb = new System.Text.StringBuilder();
            bool lastUnderscore = false;
            foreach (char c in vaultId.Trim())
            {
                if (c >= 'a' && c <= 'z') { sb.Append((char)(c - 32)); lastUnderscore = false; }
                else if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) { sb.Append(c); lastUnderscore = false; }
                else if (!lastUnderscore) { sb.Append('_'); lastUnderscore = true; }
            }
            string result = sb.ToString().Trim('_');
            return result;
        }

        public static string DefaultVaultMethod(string? provider) => provider switch
        {
            "local" => "passphrase",
            "environment" or "github-secrets" => "environment",
            _ => "",
        };

        private static string? ResolveFirstSource(VaultAuthSource? source, CnosEnvironment env)
        {
            if (source?.From == null) return null;
            foreach (string candidate in source.From)
            {
                string? v = ResolveVaultSource(candidate.Trim(), env);
                if (v != null) return v;
            }
            return null;
        }

        private static string? ResolveVaultSource(string source, CnosEnvironment env)
        {
            if (source.StartsWith("env:", StringComparison.Ordinal))
            {
                string? v = env.Get(source.Substring(4));
                if (!string.IsNullOrWhiteSpace(v)) return v!.Trim();
            }
            else if (source.StartsWith("file:", StringComparison.Ordinal))
            {
                try
                {
                    string path = ExpandHome(source.Substring(5));
                    string v = File.ReadAllText(path).Trim();
                    if (!string.IsNullOrEmpty(v)) return v;
                }
                catch { }
            }
            return null;
        }

        private static CnosError VaultAuthError(string vaultId, VaultAuthSource? source)
        {
            string tried = source?.From != null ? string.Join(", ", source.From) : "";
            return new CnosError($"cnos: cannot authenticate to vault \"{vaultId}\". Tried: {tried}");
        }

        private static byte[]? ReadSessionKey(string sessionFile)
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllBytes(sessionFile));
                var root = doc.RootElement;
                if (!root.TryGetProperty("version", out var ver) || ver.GetInt32() != 1) return null;
                if (!root.TryGetProperty("derivedKey", out var dk)) return null;
                string? hex = dk.GetString();
                if (string.IsNullOrEmpty(hex)) return null;
                byte[] k = LocalVault.HexDecode(hex);
                return k.Length == KeyLength ? k : null;
            }
            catch { return null; }
        }

        private static string? ReadPassword()
        {
            var sb = new System.Text.StringBuilder();
            ConsoleKeyInfo key;
            while (true)
            {
                key = System.Console.ReadKey(intercept: true);
                if (key.Key == ConsoleKey.Enter) break;
                if (key.Key == ConsoleKey.Backspace && sb.Length > 0) sb.Length--;
                else sb.Append(key.KeyChar);
            }
            System.Console.WriteLine();
            return sb.Length > 0 ? sb.ToString() : null;
        }

        public static string ExpandHome(string path)
        {
            if (path == "~") return System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile);
            if (path.StartsWith("~/", StringComparison.Ordinal))
                return System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile) + path.Substring(1);
            return path;
        }
    }
}
