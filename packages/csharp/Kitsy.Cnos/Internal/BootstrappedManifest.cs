using System.Collections.Generic;

namespace Kitsy.Cnos.Internal
{
    internal sealed class BootstrappedManifest
    {
        public const string KindData = "data";

        public static readonly Dictionary<string, NamespaceDef> DefaultNamespaces =
            new Dictionary<string, NamespaceDef>
            {
                ["value"]   = new NamespaceDef(KindData, false, false, true, null),
                ["secret"]  = new NamespaceDef(KindData, true, true, false, null),
                ["meta"]    = new NamespaceDef("meta", false, true, false, null),
                ["public"]  = new NamespaceDef(KindData, false, false, true, null),
                ["process"] = new NamespaceDef("runtime", false, false, false, null),
            };

        public static readonly Dictionary<string, string> DefaultFrameworks =
            new Dictionary<string, string>
            {
                ["next"]    = "NEXT_PUBLIC_",
                ["vite"]    = "VITE_",
                ["react"]   = "REACT_APP_",
                ["gatsby"]  = "GATSBY_",
            };

        public Dictionary<string, NamespaceDef> Namespaces { get; }
        public Dictionary<string, string> Frameworks { get; }
        public Dictionary<string, string> EnvMappingExplicit { get; }
        public Dictionary<string, VaultDefinition> Vaults { get; }

        public BootstrappedManifest(
            Dictionary<string, NamespaceDef> namespaces,
            Dictionary<string, string> frameworks,
            Dictionary<string, string> envMapping,
            Dictionary<string, VaultDefinition> vaults)
        {
            Namespaces = namespaces;
            Frameworks = frameworks;
            EnvMappingExplicit = envMapping;
            Vaults = vaults;
        }

        public NamespaceDef GetNamespaceDef(string ns)
        {
            if (Namespaces.TryGetValue(ns, out var def)) return def;
            return new NamespaceDef(KindData, false, false, true, null);
        }

        public sealed class NamespaceDef
        {
            public string Kind { get; }
            public bool Sensitive { get; }
            public bool ReadOnly { get; }
            public bool Shareable { get; }
            public string? Description { get; }

            public NamespaceDef(string kind, bool sensitive, bool readOnly, bool shareable, string? description)
            {
                Kind = kind; Sensitive = sensitive; ReadOnly = readOnly; Shareable = shareable; Description = description;
            }
        }
    }
}
