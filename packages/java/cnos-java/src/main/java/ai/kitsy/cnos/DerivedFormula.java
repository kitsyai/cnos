package ai.kitsy.cnos;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Collections;
import java.util.List;

/**
 * Wire type for a derived formula in a ServerProjection.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public final class DerivedFormula {

    @JsonProperty("expr")
    private final String expr;

    @JsonProperty("deps")
    private final List<String> deps;

    @JsonProperty("runtimeRefs")
    private final List<String> runtimeRefs;

    @JsonCreator
    public DerivedFormula(
            @JsonProperty("expr") String expr,
            @JsonProperty("deps") List<String> deps,
            @JsonProperty("runtimeRefs") List<String> runtimeRefs) {
        this.expr = expr;
        this.deps = deps != null ? Collections.unmodifiableList(deps) : Collections.emptyList();
        this.runtimeRefs = runtimeRefs != null ? Collections.unmodifiableList(runtimeRefs) : Collections.emptyList();
    }

    public String getExpr() { return expr; }
    public List<String> getDeps() { return deps; }
    public List<String> getRuntimeRefs() { return runtimeRefs; }
}
