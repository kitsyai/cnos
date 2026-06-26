package ai.kitsy.cnos;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Wire type for a CNOS runtime graph JSON payload ({@code __CNOS_GRAPH__}).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public final class RuntimeGraph {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @JsonProperty("entries")
    private final List<ResolvedEntry> entries;

    @JsonProperty("profile")
    private final String profile;

    @JsonProperty("resolvedAt")
    private final String resolvedAt;

    @JsonProperty("profileSource")
    private final String profileSource;

    @JsonProperty("workspace")
    private final Workspace workspace;

    @JsonCreator
    public RuntimeGraph(
            @JsonProperty("entries") List<ResolvedEntry> entries,
            @JsonProperty("profile") String profile,
            @JsonProperty("resolvedAt") String resolvedAt,
            @JsonProperty("profileSource") String profileSource,
            @JsonProperty("workspace") Workspace workspace) {
        this.entries = entries != null ? Collections.unmodifiableList(entries) : Collections.emptyList();
        this.profile = profile;
        this.resolvedAt = resolvedAt;
        this.profileSource = profileSource;
        this.workspace = workspace;
    }

    /**
     * Parses and validates a JSON byte array into a RuntimeGraph.
     *
     * @param data UTF-8 JSON bytes
     * @return parsed and validated graph
     * @throws CnosError if the JSON is malformed or the payload is invalid
     */
    public static RuntimeGraph parse(byte[] data) throws CnosError {
        RuntimeGraph raw;
        try {
            raw = MAPPER.readValue(data, RuntimeGraph.class);
        } catch (IOException e) {
            throw new CnosError("cnos: parse runtime graph: " + e.getMessage(), e);
        }

        if (isBlank(raw.profile)
                || isBlank(raw.resolvedAt)
                || isBlank(raw.profileSource)
                || raw.workspace == null
                || isBlank(raw.workspace.getWorkspaceId())
                || isBlank(raw.workspace.getWorkspaceSource())
                || raw.workspace.getWorkspaceChain() == null
                || raw.entries == null) {
            throw new CnosError("cnos: invalid runtime graph payload");
        }

        for (ResolvedEntry entry : raw.entries) {
            if (isBlank(entry.getKey())
                    || isBlank(entry.getNamespace())
                    || entry.getWinner() == null
                    || isBlank(entry.getWinner().getKey())
                    || isBlank(entry.getWinner().getNamespace())
                    || isBlank(entry.getWinner().getSourceId())
                    || isBlank(entry.getWinner().getPluginId())
                    || isBlank(entry.getWinner().getWorkspaceId())) {
                throw new CnosError("cnos: invalid runtime graph payload");
            }
        }

        return raw;
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }

    public List<ResolvedEntry> getEntries() { return entries; }
    public String getProfile() { return profile; }
    public String getResolvedAt() { return resolvedAt; }
    public String getProfileSource() { return profileSource; }
    public Workspace getWorkspace() { return workspace; }

    /**
     * A single resolved graph entry.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class ResolvedEntry {

        @JsonProperty("key")
        private final String key;

        @JsonProperty("value")
        private final Object value;

        @JsonProperty("namespace")
        private final String namespace;

        @JsonProperty("winner")
        private final ConfigEntry winner;

        @JsonProperty("overridden")
        private final List<ConfigEntry> overridden;

        @JsonCreator
        public ResolvedEntry(
                @JsonProperty("key") String key,
                @JsonProperty("value") Object value,
                @JsonProperty("namespace") String namespace,
                @JsonProperty("winner") ConfigEntry winner,
                @JsonProperty("overridden") List<ConfigEntry> overridden) {
            this.key = key;
            this.value = value;
            this.namespace = namespace;
            this.winner = winner;
            this.overridden = overridden != null ? Collections.unmodifiableList(overridden) : Collections.emptyList();
        }

        public String getKey() { return key; }
        public Object getValue() { return value; }
        public String getNamespace() { return namespace; }
        public ConfigEntry getWinner() { return winner; }
        public List<ConfigEntry> getOverridden() { return overridden; }
    }

    /**
     * A single config entry in the graph.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class ConfigEntry {

        @JsonProperty("key")
        private final String key;

        @JsonProperty("value")
        private final Object value;

        @JsonProperty("namespace")
        private final String namespace;

        @JsonProperty("sourceId")
        private final String sourceId;

        @JsonProperty("pluginId")
        private final String pluginId;

        @JsonProperty("workspaceId")
        private final String workspaceId;

        @JsonProperty("profile")
        private final String profile;

        @JsonProperty("origin")
        private final ConfigOrigin origin;

        @JsonProperty("metadata")
        private final Map<String, Object> metadata;

        @JsonCreator
        public ConfigEntry(
                @JsonProperty("key") String key,
                @JsonProperty("value") Object value,
                @JsonProperty("namespace") String namespace,
                @JsonProperty("sourceId") String sourceId,
                @JsonProperty("pluginId") String pluginId,
                @JsonProperty("workspaceId") String workspaceId,
                @JsonProperty("profile") String profile,
                @JsonProperty("origin") ConfigOrigin origin,
                @JsonProperty("metadata") Map<String, Object> metadata) {
            this.key = key;
            this.value = value;
            this.namespace = namespace;
            this.sourceId = sourceId;
            this.pluginId = pluginId;
            this.workspaceId = workspaceId;
            this.profile = profile;
            this.origin = origin;
            this.metadata = metadata != null ? Collections.unmodifiableMap(metadata) : Collections.emptyMap();
        }

        public String getKey() { return key; }
        public Object getValue() { return value; }
        public String getNamespace() { return namespace; }
        public String getSourceId() { return sourceId; }
        public String getPluginId() { return pluginId; }
        public String getWorkspaceId() { return workspaceId; }
        public String getProfile() { return profile; }
        public ConfigOrigin getOrigin() { return origin; }
        public Map<String, Object> getMetadata() { return metadata; }
    }

    /**
     * Workspace information from the graph.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class Workspace {

        @JsonProperty("workspaceId")
        private final String workspaceId;

        @JsonProperty("workspaceSource")
        private final String workspaceSource;

        @JsonProperty("globalRoot")
        private final String globalRoot;

        @JsonProperty("globalRootSource")
        private final String globalRootSource;

        @JsonProperty("workspaceChain")
        private final List<String> workspaceChain;

        @JsonProperty("workspaceRoots")
        private final List<WorkspaceRoot> workspaceRoots;

        @JsonCreator
        public Workspace(
                @JsonProperty("workspaceId") String workspaceId,
                @JsonProperty("workspaceSource") String workspaceSource,
                @JsonProperty("globalRoot") String globalRoot,
                @JsonProperty("globalRootSource") String globalRootSource,
                @JsonProperty("workspaceChain") List<String> workspaceChain,
                @JsonProperty("workspaceRoots") List<WorkspaceRoot> workspaceRoots) {
            this.workspaceId = workspaceId;
            this.workspaceSource = workspaceSource;
            this.globalRoot = globalRoot;
            this.globalRootSource = globalRootSource;
            this.workspaceChain = workspaceChain != null
                    ? Collections.unmodifiableList(workspaceChain) : Collections.emptyList();
            this.workspaceRoots = workspaceRoots != null
                    ? Collections.unmodifiableList(workspaceRoots) : Collections.emptyList();
        }

        public String getWorkspaceId() { return workspaceId; }
        public String getWorkspaceSource() { return workspaceSource; }
        public String getGlobalRoot() { return globalRoot; }
        public String getGlobalRootSource() { return globalRootSource; }
        public List<String> getWorkspaceChain() { return workspaceChain; }
        public List<WorkspaceRoot> getWorkspaceRoots() { return workspaceRoots; }
    }

    /**
     * A workspace root entry.
     */
    public static final class WorkspaceRoot {

        @JsonProperty("scope")
        private final String scope;

        @JsonProperty("workspaceId")
        private final String workspaceId;

        @JsonProperty("path")
        private final String path;

        @JsonCreator
        public WorkspaceRoot(
                @JsonProperty("scope") String scope,
                @JsonProperty("workspaceId") String workspaceId,
                @JsonProperty("path") String path) {
            this.scope = scope;
            this.workspaceId = workspaceId;
            this.path = path;
        }

        public String getScope() { return scope; }
        public String getWorkspaceId() { return workspaceId; }
        public String getPath() { return path; }
    }
}
