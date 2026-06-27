using System.Collections.Generic;
using Kitsy.Cnos;

namespace Kitsy.Cnos.Internal
{
    internal sealed class RuntimeEntry
    {
        public string Key { get; set; } = "";
        public string Namespace { get; set; } = "";
        public object? Value { get; set; }
        public string? AliasTo { get; set; }
        public string? PromotedFrom { get; set; }
        public ParsedFormula? Formula { get; set; }
        public SecretReference? SecretRef { get; set; }
        public RuntimeProvenance? Winner { get; set; }
        public List<RuntimeProvenance> Overridden { get; set; } = new();
    }

    internal sealed class RuntimeProvenance
    {
        public string SourceId { get; }
        public string PluginId { get; }
        public string WorkspaceId { get; }
        public object? Value { get; }
        public ConfigOrigin? Origin { get; }

        public RuntimeProvenance(string sourceId, string pluginId, string workspaceId,
            object? value = null, ConfigOrigin? origin = null)
        {
            SourceId = sourceId; PluginId = pluginId; WorkspaceId = workspaceId;
            Value = value; Origin = origin;
        }
    }
}
