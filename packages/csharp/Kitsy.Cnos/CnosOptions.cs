using System.Collections.Generic;

namespace Kitsy.Cnos
{
    /// <summary>Options for loading a CNOS runtime.</summary>
    public sealed class CnosOptions
    {
        /// <summary>Explicit projection JSON bytes (highest priority).</summary>
        public byte[]? ProjectionData { get; set; }

        /// <summary>Path to a projection JSON file.</summary>
        public string? ProjectionPath { get; set; }

        /// <summary>Working directory for projection file discovery.</summary>
        public string? WorkingDir { get; set; }

        /// <summary>Override environment variables (defaults to process environment).</summary>
        public Dictionary<string, string>? Environment { get; set; }

        /// <summary>Override the secret home directory (defaults to ~/.cnos/secrets).</summary>
        public string? SecretHome { get; set; }

        /// <summary>Additional vault provider factories to register.</summary>
        public List<SecretVaultProviderFactory> SecretVaultProviders { get; set; } = new();

        public static CnosOptions Defaults() => new CnosOptions();
    }

    /// <summary>Options for <see cref="CnosRuntime.ToEnv"/>.</summary>
    public sealed class ToEnvOptions
    {
        /// <summary>Include secret values in the output.</summary>
        public bool IncludeSecrets { get; set; }
    }

    /// <summary>Options for <see cref="CnosRuntime.ToPublicEnv"/>.</summary>
    public sealed class ToPublicEnvOptions
    {
        /// <summary>Explicit env var prefix (overrides framework prefix).</summary>
        public string? Prefix { get; set; }

        /// <summary>Framework name for automatic prefix (e.g. "next", "vite", "react").</summary>
        public string? Framework { get; set; }
    }
}
