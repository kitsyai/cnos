package ai.kitsy.cnos.internal;

import ai.kitsy.cnos.ConfigOrigin;

/**
 * Internal provenance metadata for a runtime entry source.
 */
public final class RuntimeProvenance {

    private final String sourceId;
    private final String pluginId;
    private final String workspaceId;
    private final Object value;
    private final ConfigOrigin origin;

    public RuntimeProvenance(String sourceId, String pluginId, String workspaceId,
            Object value, ConfigOrigin origin) {
        this.sourceId = sourceId;
        this.pluginId = pluginId;
        this.workspaceId = workspaceId;
        this.value = value;
        this.origin = origin;
    }

    public RuntimeProvenance(String sourceId, String pluginId, String workspaceId) {
        this(sourceId, pluginId, workspaceId, null, null);
    }

    public String getSourceId() { return sourceId; }
    public String getPluginId() { return pluginId; }
    public String getWorkspaceId() { return workspaceId; }
    public Object getValue() { return value; }
    public ConfigOrigin getOrigin() { return origin; }
}
