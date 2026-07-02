using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Kitsy.Cnos
{
    /// <summary>Wire format for the CNOS server projection JSON payload.</summary>
    public sealed class ServerProjection
    {
        [JsonPropertyName("version")]
        public int Version { get; set; }

        [JsonPropertyName("workspace")]
        public string Workspace { get; set; } = "";

        [JsonPropertyName("profile")]
        public string Profile { get; set; } = "";

        [JsonPropertyName("resolvedAt")]
        public string ResolvedAt { get; set; } = "";

        [JsonPropertyName("configHash")]
        public string ConfigHash { get; set; } = "";

        [JsonPropertyName("values")]
        public Dictionary<string, JsonElement> Values { get; set; } = new();

        [JsonPropertyName("derived")]
        public Dictionary<string, DerivedFormula> Derived { get; set; } = new();

        [JsonPropertyName("secretRefs")]
        public Dictionary<string, SecretReference> SecretRefs { get; set; } = new();

        [JsonPropertyName("vaults")]
        public Dictionary<string, VaultDefinition> Vaults { get; set; } = new();

        [JsonPropertyName("publicKeys")]
        public List<string> PublicKeys { get; set; } = new();

        [JsonPropertyName("runtimeNamespaces")]
        public List<string> RuntimeNamespaces { get; set; } = new();

        [JsonPropertyName("valueTypes")]
        public Dictionary<string, string>? ValueTypes { get; set; }

        [JsonPropertyName("meta")]
        public ProjectionMeta Meta { get; set; } = new();

        private static readonly JsonSerializerOptions _opts = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        };

        /// <summary>Parses and validates a server projection JSON payload.</summary>
        public static ServerProjection Parse(byte[] data)
        {
            ServerProjection? p;
            try
            {
                p = JsonSerializer.Deserialize<ServerProjection>(data, _opts);
            }
            catch (Exception ex)
            {
                throw new CnosError("cnos: parse server projection: " + ex.Message, ex);
            }

            if (p == null
                || p.Version != 1
                || string.IsNullOrEmpty(p.Workspace)
                || string.IsNullOrEmpty(p.Profile)
                || string.IsNullOrEmpty(p.ResolvedAt)
                || string.IsNullOrEmpty(p.ConfigHash)
                || p.Values == null
                || p.SecretRefs == null
                || p.PublicKeys == null
                || string.IsNullOrEmpty(p.Meta?.Workspace)
                || string.IsNullOrEmpty(p.Meta?.Profile)
                || string.IsNullOrEmpty(p.Meta?.CnosVersion))
            {
                throw new CnosError("cnos: invalid server projection payload");
            }

            p.Derived ??= new Dictionary<string, DerivedFormula>();
            p.RuntimeNamespaces ??= new List<string>();
            p.Vaults ??= new Dictionary<string, VaultDefinition>();
            p.Meta.Namespaces ??= new List<string>();

            // Normalize secret ref defaults
            var normalizedRefs = new Dictionary<string, SecretReference>(p.SecretRefs.Count);
            foreach (var kv in p.SecretRefs)
            {
                var r = kv.Value;
                if (string.IsNullOrEmpty(r.Vault)) r = r.WithVault("default");
                if (string.IsNullOrEmpty(r.Provider))
                {
                    if (p.Vaults.TryGetValue(r.Vault, out var def) && !string.IsNullOrEmpty(def.Provider))
                        r = r.WithProvider(def.Provider);
                    else
                        r = r.WithProvider("local");
                }
                normalizedRefs[kv.Key] = r;
            }
            p.SecretRefs = normalizedRefs;

            return p;
        }
    }

    public sealed class ProjectionMeta
    {
        [JsonPropertyName("workspace")]
        public string Workspace { get; set; } = "";

        [JsonPropertyName("profile")]
        public string Profile { get; set; } = "";

        [JsonPropertyName("cnos_version")]
        public string CnosVersion { get; set; } = "";

        [JsonPropertyName("namespaces")]
        public List<string>? Namespaces { get; set; }
    }

    public sealed class DerivedFormula
    {
        [JsonPropertyName("expr")]
        public string Expr { get; set; } = "";

        [JsonPropertyName("deps")]
        public List<string> Deps { get; set; } = new();

        [JsonPropertyName("runtimeRefs")]
        public List<string> RuntimeRefs { get; set; } = new();
    }

    public sealed class SecretReference
    {
        [JsonPropertyName("provider")]
        public string Provider { get; set; } = "";

        [JsonPropertyName("ref")]
        public string Ref { get; set; } = "";

        [JsonPropertyName("vault")]
        public string Vault { get; set; } = "";

        [JsonPropertyName("envVar")]
        public string? EnvVar { get; set; }

        public SecretReference WithVault(string vault) =>
            new SecretReference { Provider = Provider, Ref = Ref, Vault = vault, EnvVar = EnvVar };

        public SecretReference WithProvider(string provider) =>
            new SecretReference { Provider = provider, Ref = Ref, Vault = Vault, EnvVar = EnvVar };
    }
}
