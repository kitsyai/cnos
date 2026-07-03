using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;
using Kitsy.Cnos;

namespace Kitsy.Cnos.Internal
{
    internal sealed class RuntimeGraph
    {
        [JsonPropertyName("workspace")]
        public WorkspaceContext Workspace { get; set; } = new();

        [JsonPropertyName("profileSource")]
        public string ProfileSource { get; set; } = "";

        [JsonPropertyName("resolvedAt")]
        public string ResolvedAt { get; set; } = "";

        [JsonPropertyName("entries")]
        public List<ResolvedEntry> Entries { get; set; } = new();

        [JsonPropertyName("overrides")]
        public Dictionary<string, OverrideSpec>? Overrides { get; set; }

        private static readonly JsonSerializerOptions _opts = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        };

        public static RuntimeGraph Parse(byte[] data)
        {
            RuntimeGraph? g;
            try
            {
                g = JsonSerializer.Deserialize<RuntimeGraph>(data, _opts);
            }
            catch (Exception ex)
            {
                throw new CnosError("cnos: parse runtime graph: " + ex.Message, ex);
            }

            if (g == null) throw new CnosError("cnos: invalid runtime graph payload");
            g.Entries ??= new List<ResolvedEntry>();
            return g;
        }

        public sealed class WorkspaceContext
        {
            [JsonPropertyName("workspaceId")]
            public string WorkspaceId { get; set; } = "";

            [JsonPropertyName("workspaceSource")]
            public string WorkspaceSource { get; set; } = "";

            [JsonPropertyName("workspaceChain")]
            public List<string> WorkspaceChain { get; set; } = new();
        }

        public sealed class ResolvedEntry
        {
            [JsonPropertyName("key")]
            public string Key { get; set; } = "";

            [JsonPropertyName("namespace")]
            public string Namespace { get; set; } = "";

            [JsonPropertyName("value")]
            public JsonElement? Value { get; set; }

            [JsonPropertyName("winner")]
            public ConfigEntry Winner { get; set; } = new();

            [JsonPropertyName("overridden")]
            public List<ConfigEntry> Overridden { get; set; } = new();
        }

        public sealed class ConfigEntry
        {
            [JsonPropertyName("sourceId")]
            public string SourceId { get; set; } = "";

            [JsonPropertyName("pluginId")]
            public string PluginId { get; set; } = "";

            [JsonPropertyName("workspaceId")]
            public string WorkspaceId { get; set; } = "";

            [JsonPropertyName("value")]
            public JsonElement? Value { get; set; }

            [JsonPropertyName("origin")]
            public ConfigOrigin? Origin { get; set; }

            [JsonPropertyName("metadata")]
            public Dictionary<string, JsonElement>? Metadata { get; set; }
        }
    }
}
