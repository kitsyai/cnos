package ai.kitsy.cnos.internal;

import ai.kitsy.cnos.CnosError;

import java.util.ArrayList;
import java.util.List;

/**
 * Evaluator for the CNOS derive expression AST.
 * Mirrors Go's evaluateDerivedFormula / evaluateNode / evaluateCall.
 */
public final class FormulaEvaluator {

    private FormulaEvaluator() {}

    @FunctionalInterface
    public interface RefResolver {
        /**
         * Resolves a config key reference.
         *
         * @param ref the key
         * @return a two-element array: {@code [value, found]} where found is Boolean
         * @throws CnosError on resolution failure
         */
        Object[] resolve(String ref) throws CnosError;
    }

    /**
     * Evaluates a parsed formula, returning the resolved value.
     *
     * @param key     the owning config key (used in error messages)
     * @param formula the parsed formula
     * @param resolver function to resolve a ref key to (value, found)
     * @return the evaluated value
     * @throws CnosError on evaluation failure or unresolvable ref
     */
    public static Object evaluate(String key, ParsedFormula formula, RefResolver resolver) throws CnosError {
        Object[] result = evaluateNode(formula.getAst(), resolver);
        Object value = result[0];
        boolean found = (Boolean) result[1];

        if ("ref".equals(formula.getAst().getKind()) && !found) {
            throw new CnosError("cnos: unable to resolve derived config key " + key
                    + " because " + formula.getAst().getPath() + " is missing");
        }
        return value;
    }

    /** Returns [value, found(Boolean)] */
    static Object[] evaluateNode(ExprNode node, RefResolver resolver) throws CnosError {
        switch (node.getKind()) {
            case "literal":
                return new Object[]{node.getValue(), Boolean.TRUE};
            case "ref":
                return resolver.resolve(node.getPath());
            case "call": {
                List<Object[]> evaluated = new ArrayList<>(node.getArgs().size());
                for (ExprNode arg : node.getArgs()) {
                    evaluated.add(evaluateNode(arg, resolver));
                }
                Object[] values = new Object[evaluated.size()];
                boolean[] flags = new boolean[evaluated.size()];
                for (int i = 0; i < evaluated.size(); i++) {
                    values[i] = evaluated.get(i)[0];
                    flags[i] = (Boolean) evaluated.get(i)[1];
                }
                return evaluateCall(node.getName(), values, flags);
            }
            default:
                throw new CnosError("cnos: unsupported derive AST node \"" + node.getKind() + "\"");
        }
    }

    private static Object[] evaluateCall(String name, Object[] values, boolean[] flags) throws CnosError {
        switch (name) {
            case "concat": {
                StringBuilder sb = new StringBuilder();
                for (Object v : values) {
                    sb.append(JsCompat.jsStringifyValue(v));
                }
                return new Object[]{sb.toString(), Boolean.TRUE};
            }
            case "coalesce": {
                for (Object v : values) {
                    if (v != null) return new Object[]{v, Boolean.TRUE};
                }
                return new Object[]{null, Boolean.TRUE};
            }
            case "when": {
                Object cond = values.length > 0 ? values[0] : null;
                Object whenTrue = values.length > 1 ? values[1] : null;
                Object whenFalse = values.length > 2 ? values[2] : null;
                return new Object[]{isTruthy(cond) ? whenTrue : whenFalse, Boolean.TRUE};
            }
            case "exists": {
                if (values.length == 0) return new Object[]{Boolean.FALSE, Boolean.TRUE};
                boolean exists = flags[0] && values[0] != null;
                return new Object[]{exists, Boolean.TRUE};
            }
            case "eq": {
                Object left = values.length > 0 ? values[0] : null;
                Object right = values.length > 1 ? values[1] : null;
                return new Object[]{JsCompat.jsStrictEqual(left, right), Boolean.TRUE};
            }
            case "ne": {
                Object left = values.length > 0 ? values[0] : null;
                Object right = values.length > 1 ? values[1] : null;
                return new Object[]{!JsCompat.jsStrictEqual(left, right), Boolean.TRUE};
            }
            default:
                throw new CnosError("cnos: unknown derive function: " + name);
        }
    }

    static boolean isTruthy(Object value) {
        if (value == null) return false;
        if (value instanceof Boolean) return (Boolean) value;
        if (value instanceof String) return !((String) value).isEmpty();
        if (value instanceof Double) return (Double) value != 0.0;
        if (value instanceof Float) return (Float) value != 0.0f;
        if (value instanceof Long) return (Long) value != 0L;
        if (value instanceof Integer) return (Integer) value != 0;
        if (value instanceof Number) return ((Number) value).doubleValue() != 0;
        return true; // non-null objects are truthy
    }
}
