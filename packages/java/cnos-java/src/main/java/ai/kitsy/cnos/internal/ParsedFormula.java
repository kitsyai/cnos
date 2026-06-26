package ai.kitsy.cnos.internal;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Parsed state of a derive formula, including AST and dependency metadata.
 */
public final class ParsedFormula {

    private final String raw;
    private List<String> refs;
    private List<String> deps;
    private List<String> runtimeRefs;
    private boolean runtimeDependent;
    private final ExprNode ast;

    public ParsedFormula(String raw, List<String> refs, List<String> deps,
            List<String> runtimeRefs, boolean runtimeDependent, ExprNode ast) {
        this.raw = raw;
        this.refs = refs != null ? new ArrayList<>(refs) : new ArrayList<>();
        this.deps = deps != null ? new ArrayList<>(deps) : new ArrayList<>();
        this.runtimeRefs = runtimeRefs != null ? new ArrayList<>(runtimeRefs) : new ArrayList<>();
        this.runtimeDependent = runtimeDependent;
        this.ast = ast;
    }

    public String getRaw() { return raw; }
    public List<String> getRefs() { return Collections.unmodifiableList(refs); }
    public List<String> getDeps() { return Collections.unmodifiableList(deps); }
    public List<String> getRuntimeRefs() { return Collections.unmodifiableList(runtimeRefs); }
    public boolean isRuntimeDependent() { return runtimeDependent; }
    public ExprNode getAst() { return ast; }

    /** Replaces the runtime refs list (called during prepareDerivedEntries). */
    public void setRuntimeRefs(List<String> runtimeRefs) {
        this.runtimeRefs = new ArrayList<>(runtimeRefs);
    }

    /** Sets the runtime-dependent flag. */
    public void setRuntimeDependent(boolean runtimeDependent) {
        this.runtimeDependent = runtimeDependent;
    }

    /** Replaces the deps list (config-only deps, filtered from runtime namespaces). */
    public void setDeps(List<String> deps) {
        this.deps = new ArrayList<>(deps);
    }

    public boolean isTemplate() {
        return raw != null && raw.contains("${");
    }
}
