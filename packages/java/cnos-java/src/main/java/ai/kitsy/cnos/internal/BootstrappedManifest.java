package ai.kitsy.cnos.internal;

import ai.kitsy.cnos.VaultDefinition;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * Internal manifest bootstrapped from a projection or graph payload.
 * Carries the subset of manifest state needed by the consumer-path runtime.
 */
public final class BootstrappedManifest {

    public static final String KIND_DATA = "data";
    public static final String KIND_SYSTEM = "system";
    public static final String KIND_PROJECTION = "projection";

    public static final Map<String, NamespaceDef> DEFAULT_NAMESPACES;
    public static final Map<String, String> DEFAULT_FRAMEWORKS;

    static {
        Map<String, NamespaceDef> ns = new HashMap<>();
        ns.put("value",   new NamespaceDef(KIND_DATA,       true,  false, false, null));
        ns.put("secret",  new NamespaceDef(KIND_DATA,       false, true,  false, null));
        ns.put("meta",    new NamespaceDef(KIND_SYSTEM,     false, false, true,  null));
        ns.put("process", new NamespaceDef(KIND_SYSTEM,     false, false, true,  null));
        ns.put("public",  new NamespaceDef(KIND_PROJECTION, true,  false, true,  "promote"));
        ns.put("env",     new NamespaceDef(KIND_PROJECTION, true,  false, true,  "envMapping"));
        DEFAULT_NAMESPACES = Collections.unmodifiableMap(ns);

        Map<String, String> fw = new HashMap<>();
        fw.put("next",    "NEXT_PUBLIC_");
        fw.put("vite",    "VITE_");
        fw.put("nuxt",    "NUXT_PUBLIC_");
        fw.put("webpack", "");
        DEFAULT_FRAMEWORKS = Collections.unmodifiableMap(fw);
    }

    private final Map<String, NamespaceDef> namespaces;
    private final Map<String, String> frameworks;
    private final Map<String, String> envMappingExplicit;
    private final Map<String, VaultDefinition> vaults;

    public BootstrappedManifest(
            Map<String, NamespaceDef> namespaces,
            Map<String, String> frameworks,
            Map<String, String> envMappingExplicit,
            Map<String, VaultDefinition> vaults) {
        this.namespaces = namespaces != null ? namespaces : new HashMap<>(DEFAULT_NAMESPACES);
        this.frameworks = frameworks != null ? frameworks : new HashMap<>(DEFAULT_FRAMEWORKS);
        this.envMappingExplicit = envMappingExplicit != null ? envMappingExplicit : Collections.emptyMap();
        this.vaults = vaults != null ? vaults : Collections.emptyMap();
    }

    public Map<String, NamespaceDef> getNamespaces() { return namespaces; }
    public Map<String, String> getFrameworks() { return frameworks; }
    public Map<String, String> getEnvMappingExplicit() { return envMappingExplicit; }
    public Map<String, VaultDefinition> getVaults() { return vaults; }

    /** Returns the namespace definition, falling back to defaults. */
    public NamespaceDef getNamespaceDef(String namespace) {
        NamespaceDef def = namespaces.get(namespace);
        if (def != null) return def;
        def = DEFAULT_NAMESPACES.get(namespace);
        if (def != null) return def;
        return new NamespaceDef(KIND_DATA, false, false, false, null);
    }

    /**
     * Namespace definition — mirrors Go's namespaceDefinition.
     */
    public static final class NamespaceDef {
        private final String kind;
        private final boolean shareable;
        private final boolean sensitive;
        private final boolean readonly;
        private final String source;

        public NamespaceDef(String kind, boolean shareable, boolean sensitive, boolean readonly, String source) {
            this.kind = kind;
            this.shareable = shareable;
            this.sensitive = sensitive;
            this.readonly = readonly;
            this.source = source;
        }

        public String getKind() { return kind; }
        public boolean isShareable() { return shareable; }
        public boolean isSensitive() { return sensitive; }
        public boolean isReadonly() { return readonly; }
        public String getSource() { return source; }
    }
}
