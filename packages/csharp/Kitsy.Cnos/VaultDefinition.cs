using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Kitsy.Cnos
{
    /// <summary>Vault definition — both JSON wire form and provider API type.</summary>
    public sealed class VaultDefinition
    {
        [JsonPropertyName("provider")]
        public string Provider { get; set; } = "";

        [JsonPropertyName("auth")]
        public VaultAuth Auth { get; set; } = new();

        [JsonPropertyName("mapping")]
        public Dictionary<string, string> Mapping { get; set; } = new();

        [JsonPropertyName("fallback")]
        public List<VaultDefinition> Fallback { get; set; } = new();

        public VaultDefinition WithProvider(string provider) => new VaultDefinition
        {
            Provider = provider,
            Auth = Auth,
            Mapping = Mapping,
            Fallback = Fallback,
        };
    }

    public sealed class VaultAuth
    {
        [JsonPropertyName("method")]
        public string? Method { get; set; }

        [JsonPropertyName("passphrase")]
        public VaultAuthSource? Passphrase { get; set; }

        [JsonPropertyName("token")]
        public VaultAuthSource? Token { get; set; }

        [JsonPropertyName("config")]
        public Dictionary<string, object>? Config { get; set; }
    }

    public sealed class VaultAuthSource
    {
        [JsonPropertyName("from")]
        public List<string> From { get; set; } = new();
    }

    /// <summary>Resolved vault auth credentials passed to <see cref="ISecretVaultProvider.Authenticate"/>.</summary>
    public sealed class VaultAuthConfig
    {
        public string Method { get; }
        public string? Passphrase { get; }
        public string? Token { get; }
        public Dictionary<string, object> Config { get; }

        private VaultAuthConfig(string method, string? passphrase, string? token, Dictionary<string, object>? config)
        {
            Method = method;
            Passphrase = passphrase;
            Token = token;
            Config = config ?? new Dictionary<string, object>();
        }

        public static VaultAuthConfig OfMethod(string method, Dictionary<string, object>? config = null) =>
            new VaultAuthConfig(method, null, null, config);

        public static VaultAuthConfig OfPassphrase(string passphrase, Dictionary<string, object>? config = null) =>
            new VaultAuthConfig("passphrase", passphrase, null, config);

        public static VaultAuthConfig OfToken(string token, Dictionary<string, object>? config = null) =>
            new VaultAuthConfig("token", null, token, config);
    }
}
