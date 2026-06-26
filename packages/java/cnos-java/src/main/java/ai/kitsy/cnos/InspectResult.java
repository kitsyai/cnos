package ai.kitsy.cnos;

import java.util.Collections;
import java.util.List;

/**
 * Full inspection result for a single config key.
 */
public final class InspectResult {

    private final String key;
    private final Object value;
    private final String namespace;
    private final String profile;
    private final String profileSource;
    private final InspectWorkspace workspace;
    private final InspectWinner winner;
    private final List<InspectOverride> overridden;
    private final InspectDerived derived;

    public InspectResult(
            String key, Object value, String namespace, String profile,
            String profileSource, InspectWorkspace workspace,
            InspectWinner winner, List<InspectOverride> overridden,
            InspectDerived derived) {
        this.key = key;
        this.value = value;
        this.namespace = namespace;
        this.profile = profile;
        this.profileSource = profileSource;
        this.workspace = workspace;
        this.winner = winner;
        this.overridden = overridden != null ? Collections.unmodifiableList(overridden) : Collections.emptyList();
        this.derived = derived;
    }

    public String getKey() { return key; }
    public Object getValue() { return value; }
    public String getNamespace() { return namespace; }
    public String getProfile() { return profile; }
    public String getProfileSource() { return profileSource; }
    public InspectWorkspace getWorkspace() { return workspace; }
    public InspectWinner getWinner() { return winner; }
    public List<InspectOverride> getOverridden() { return overridden; }
    /** May be {@code null} for non-derived entries. */
    public InspectDerived getDerived() { return derived; }

    /**
     * Workspace info at the time of resolution.
     */
    public static final class InspectWorkspace {
        private final String id;
        private final String source;
        private final List<String> chain;

        public InspectWorkspace(String id, String source, List<String> chain) {
            this.id = id;
            this.source = source;
            this.chain = chain != null ? Collections.unmodifiableList(chain) : Collections.emptyList();
        }

        public String getId() { return id; }
        public String getSource() { return source; }
        public List<String> getChain() { return chain; }
    }

    /**
     * The winning (highest-precedence) config source for this key.
     */
    public static final class InspectWinner {
        private final String sourceId;
        private final String pluginId;
        private final String workspaceId;
        private final ConfigOrigin origin;

        public InspectWinner(String sourceId, String pluginId, String workspaceId, ConfigOrigin origin) {
            this.sourceId = sourceId;
            this.pluginId = pluginId;
            this.workspaceId = workspaceId;
            this.origin = origin;
        }

        public String getSourceId() { return sourceId; }
        public String getPluginId() { return pluginId; }
        public String getWorkspaceId() { return workspaceId; }
        public ConfigOrigin getOrigin() { return origin; }
    }

    /**
     * An overridden (lower-precedence) source for this key.
     */
    public static final class InspectOverride {
        private final String sourceId;
        private final String pluginId;
        private final String workspaceId;
        private final Object value;
        private final ConfigOrigin origin;

        public InspectOverride(String sourceId, String pluginId, String workspaceId,
                Object value, ConfigOrigin origin) {
            this.sourceId = sourceId;
            this.pluginId = pluginId;
            this.workspaceId = workspaceId;
            this.value = value;
            this.origin = origin;
        }

        public String getSourceId() { return sourceId; }
        public String getPluginId() { return pluginId; }
        public String getWorkspaceId() { return workspaceId; }
        public Object getValue() { return value; }
        public ConfigOrigin getOrigin() { return origin; }
    }

    /**
     * Derived formula details for derived entries.
     */
    public static final class InspectDerived {
        private final String type;
        private final String expression;
        private final List<InspectDependency> dependencies;
        private final boolean runtimeDependent;
        private final List<String> runtimeNamespaces;
        private final String promotionWarning;

        public InspectDerived(
                String type, String expression, List<InspectDependency> dependencies,
                boolean runtimeDependent, List<String> runtimeNamespaces,
                String promotionWarning) {
            this.type = type;
            this.expression = expression;
            this.dependencies = dependencies != null
                    ? Collections.unmodifiableList(dependencies) : Collections.emptyList();
            this.runtimeDependent = runtimeDependent;
            this.runtimeNamespaces = runtimeNamespaces != null
                    ? Collections.unmodifiableList(runtimeNamespaces) : Collections.emptyList();
            this.promotionWarning = promotionWarning;
        }

        public String getType() { return type; }
        public String getExpression() { return expression; }
        public List<InspectDependency> getDependencies() { return dependencies; }
        public boolean isRuntimeDependent() { return runtimeDependent; }
        public List<String> getRuntimeNamespaces() { return runtimeNamespaces; }
        public String getPromotionWarning() { return promotionWarning; }
    }

    /**
     * A single dependency of a derived formula.
     */
    public static final class InspectDependency {
        private final String key;
        private final Object value;
        private final String runtimeNamespace;

        public InspectDependency(String key, Object value, String runtimeNamespace) {
            this.key = key;
            this.value = value;
            this.runtimeNamespace = runtimeNamespace;
        }

        public String getKey() { return key; }
        public Object getValue() { return value; }
        /** Non-null only when this dep belongs to a runtime namespace. */
        public String getRuntimeNamespace() { return runtimeNamespace; }
    }
}
