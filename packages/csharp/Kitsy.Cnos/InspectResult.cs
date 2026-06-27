using System.Collections.Generic;

namespace Kitsy.Cnos
{
    /// <summary>Provenance and derivation details for a config key.</summary>
    public sealed class InspectResult
    {
        public string Key { get; }
        public object? Value { get; }
        public string Namespace { get; }
        public string Profile { get; }
        public string ProfileSource { get; }
        public InspectWorkspace Workspace { get; }
        public InspectWinner Winner { get; }
        public IReadOnlyList<InspectOverride> Overrides { get; }
        public InspectDerived? Derived { get; }

        public InspectResult(string key, object? value, string ns, string profile, string profileSource,
            InspectWorkspace workspace, InspectWinner winner,
            IReadOnlyList<InspectOverride> overrides, InspectDerived? derived)
        {
            Key = key;
            Value = value;
            Namespace = ns;
            Profile = profile;
            ProfileSource = profileSource;
            Workspace = workspace;
            Winner = winner;
            Overrides = overrides;
            Derived = derived;
        }

        public sealed class InspectWorkspace
        {
            public string Id { get; }
            public string Source { get; }
            public IReadOnlyList<string> Chain { get; }

            public InspectWorkspace(string id, string source, IReadOnlyList<string> chain)
            {
                Id = id; Source = source; Chain = chain;
            }
        }

        public sealed class InspectWinner
        {
            public string SourceId { get; }
            public string PluginId { get; }
            public string WorkspaceId { get; }
            public ConfigOrigin? Origin { get; }

            public InspectWinner(string sourceId, string pluginId, string workspaceId, ConfigOrigin? origin)
            {
                SourceId = sourceId; PluginId = pluginId; WorkspaceId = workspaceId; Origin = origin;
            }
        }

        public sealed class InspectOverride
        {
            public string SourceId { get; }
            public string PluginId { get; }
            public string WorkspaceId { get; }
            public object? Value { get; }
            public ConfigOrigin? Origin { get; }

            public InspectOverride(string sourceId, string pluginId, string workspaceId, object? value, ConfigOrigin? origin)
            {
                SourceId = sourceId; PluginId = pluginId; WorkspaceId = workspaceId; Value = value; Origin = origin;
            }
        }

        public sealed class InspectDerived
        {
            public string Kind { get; }
            public string Raw { get; }
            public IReadOnlyList<InspectDependency> Deps { get; }
            public bool RuntimeDependent { get; }
            public IReadOnlyList<string> RuntimeNamespaces { get; }
            public string? PromotionWarning { get; }

            public InspectDerived(string kind, string raw, IReadOnlyList<InspectDependency> deps,
                bool runtimeDependent, IReadOnlyList<string> runtimeNamespaces, string? promotionWarning)
            {
                Kind = kind; Raw = raw; Deps = deps; RuntimeDependent = runtimeDependent;
                RuntimeNamespaces = runtimeNamespaces; PromotionWarning = promotionWarning;
            }
        }

        public sealed class InspectDependency
        {
            public string Key { get; }
            public object? Value { get; }
            public string? RuntimeNamespace { get; }

            public InspectDependency(string key, object? value, string? runtimeNamespace)
            {
                Key = key; Value = value; RuntimeNamespace = runtimeNamespace;
            }
        }
    }

    /// <summary>Origin metadata for a config entry.</summary>
    public sealed class ConfigOrigin
    {
        public string? File { get; set; }
        public int? Line { get; set; }
        public string? EnvVar { get; set; }
        public string? CliArg { get; set; }

        public ConfigOrigin Copy() => new ConfigOrigin
        {
            File = File, Line = Line, EnvVar = EnvVar, CliArg = CliArg,
        };
    }
}
