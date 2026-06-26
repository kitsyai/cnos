package ai.kitsy.cnos.internal;

import ai.kitsy.cnos.SecretReference;

import java.util.ArrayList;
import java.util.List;

/**
 * Internal runtime representation of a single config entry.
 */
public final class RuntimeEntry {

    private final String key;
    private final String namespace;
    private final Object value;
    private final String aliasTo;
    private final String promotedFrom;
    private final ParsedFormula formula;
    private final SecretReference secretRef;
    private final RuntimeProvenance winner;
    private final List<RuntimeProvenance> overridden;

    // Derived formula cache — mutable, only written after evaluation
    private boolean formulaCached;
    private Object formulaCache;

    public RuntimeEntry(
            String key, String namespace, Object value,
            String aliasTo, String promotedFrom,
            ParsedFormula formula, SecretReference secretRef,
            RuntimeProvenance winner, List<RuntimeProvenance> overridden) {
        this.key = key;
        this.namespace = namespace;
        this.value = value;
        this.aliasTo = aliasTo;
        this.promotedFrom = promotedFrom;
        this.formula = formula;
        this.secretRef = secretRef;
        this.winner = winner;
        this.overridden = overridden != null ? new ArrayList<>(overridden) : new ArrayList<>();
    }

    public String getKey() { return key; }
    public String getNamespace() { return namespace; }
    public Object getValue() { return value; }
    public String getAliasTo() { return aliasTo; }
    public String getPromotedFrom() { return promotedFrom; }
    public ParsedFormula getFormula() { return formula; }
    public SecretReference getSecretRef() { return secretRef; }
    public RuntimeProvenance getWinner() { return winner; }
    public List<RuntimeProvenance> getOverridden() { return overridden; }

    public boolean isFormulaCached() { return formulaCached; }
    public Object getFormulaCache() { return formulaCache; }

    public void setFormulaCache(Object value) {
        this.formulaCache = value;
        this.formulaCached = true;
    }

    /** Builder for constructing RuntimeEntry instances. */
    public static final class Builder {
        private String key;
        private String namespace;
        private Object value;
        private String aliasTo;
        private String promotedFrom;
        private ParsedFormula formula;
        private SecretReference secretRef;
        private RuntimeProvenance winner;
        private List<RuntimeProvenance> overridden;

        public Builder key(String key) { this.key = key; return this; }
        public Builder namespace(String namespace) { this.namespace = namespace; return this; }
        public Builder value(Object value) { this.value = value; return this; }
        public Builder aliasTo(String aliasTo) { this.aliasTo = aliasTo; return this; }
        public Builder promotedFrom(String promotedFrom) { this.promotedFrom = promotedFrom; return this; }
        public Builder formula(ParsedFormula formula) { this.formula = formula; return this; }
        public Builder secretRef(SecretReference secretRef) { this.secretRef = secretRef; return this; }
        public Builder winner(RuntimeProvenance winner) { this.winner = winner; return this; }
        public Builder overridden(List<RuntimeProvenance> overridden) { this.overridden = overridden; return this; }

        public RuntimeEntry build() {
            return new RuntimeEntry(key, namespace, value, aliasTo, promotedFrom,
                    formula, secretRef, winner, overridden);
        }
    }
}
