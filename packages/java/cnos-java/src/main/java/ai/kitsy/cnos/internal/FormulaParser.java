package ai.kitsy.cnos.internal;

import ai.kitsy.cnos.CnosError;
import ai.kitsy.cnos.DerivedFormula;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Parser for the CNOS derive expression language.
 * Supports two modes:
 * <ul>
 *   <li><b>Template</b>: source contains {@code ${...}} — parsed as a concat AST.</li>
 *   <li><b>Expression</b>: function-call syntax — {@code concat}, {@code coalesce},
 *       {@code when}, {@code exists}, {@code eq}, {@code ne}, plus literals and bare refs.</li>
 * </ul>
 */
public final class FormulaParser {

    private static final Set<String> BUILTINS = new HashSet<>();

    static {
        BUILTINS.add("concat");
        BUILTINS.add("coalesce");
        BUILTINS.add("when");
        BUILTINS.add("exists");
        BUILTINS.add("eq");
        BUILTINS.add("ne");
    }

    private FormulaParser() {}

    /**
     * Parses a {@link DerivedFormula} wire type into a {@link ParsedFormula}.
     */
    public static ParsedFormula parseDerivedFormula(DerivedFormula formula) throws CnosError {
        ExprNode ast = parseDerivedSource(formula.getExpr());

        List<String> refs = new ArrayList<>(formula.getDeps());
        refs.addAll(formula.getRuntimeRefs());

        return new ParsedFormula(
                formula.getExpr(),
                uniqueSorted(refs),
                new ArrayList<>(formula.getDeps()),
                new ArrayList<>(formula.getRuntimeRefs()),
                !formula.getRuntimeRefs().isEmpty(),
                ast);
    }

    /**
     * Parses a raw derived value (from a graph entry) — the {@code {$derive: ...}} pattern.
     */
    public static ParsedFormula parseRawDerivedValue(Object value) throws CnosError {
        String source = deriveSourceFromValue(value);
        ExprNode ast = parseDerivedSource(source);
        List<String> refs = uniqueSorted(extractRefs(ast, new ArrayList<>()));

        return new ParsedFormula(source, refs, new ArrayList<>(refs), new ArrayList<>(), false, ast);
    }

    public static boolean isDerivedValue(Object value) {
        if (!(value instanceof java.util.Map)) return false;
        @SuppressWarnings("unchecked")
        java.util.Map<String, Object> map = (java.util.Map<String, Object>) value;
        return map.containsKey("$derive");
    }

    private static String deriveSourceFromValue(Object value) throws CnosError {
        if (!(value instanceof java.util.Map)) {
            throw new CnosError("cnos: derived value requires either a template string or { expr } object");
        }
        @SuppressWarnings("unchecked")
        java.util.Map<String, Object> doc = (java.util.Map<String, Object>) value;
        Object raw = doc.get("$derive");
        if (raw == null) {
            throw new CnosError("cnos: derived value requires either a template string or { expr } object");
        }
        if (raw instanceof String) {
            return (String) raw;
        }
        if (raw instanceof java.util.Map) {
            @SuppressWarnings("unchecked")
            java.util.Map<String, Object> deriveMap = (java.util.Map<String, Object>) raw;
            Object exprObj = deriveMap.get("expr");
            if (exprObj instanceof String) {
                String expr = ((String) exprObj).trim();
                if (!expr.isEmpty()) return expr;
            }
        }
        throw new CnosError("cnos: derived value requires either a template string or { expr } object");
    }

    /** Parses a derive source string into an AST node. */
    public static ExprNode parseDerivedSource(String source) throws CnosError {
        if (source.contains("${")) {
            return parseTemplate(source);
        }
        ParserState state = new ParserState(source);
        ExprNode node = parseExpressionNode(state);
        skipWhitespace(state);
        if (state.index != state.source.length()) {
            throw state.error("Unexpected trailing input");
        }
        return node;
    }

    private static ExprNode parseTemplate(String source) throws CnosError {
        List<ExprNode> parts = new ArrayList<>();
        int cursor = 0;

        while (cursor < source.length()) {
            int start = source.indexOf("${", cursor);
            if (start < 0) {
                if (cursor < source.length()) {
                    parts.add(ExprNode.literal(source.substring(cursor)));
                }
                break;
            }
            if (start > cursor) {
                parts.add(ExprNode.literal(source.substring(cursor, start)));
            }
            int end = source.indexOf('}', start + 2);
            if (end < 0) {
                throw new CnosError("cnos: invalid derivation template: unclosed ${...} at position " + (start + 1));
            }
            String ref = source.substring(start + 2, end).trim();
            if (ref.isEmpty()) {
                throw new CnosError("cnos: invalid derivation template: empty reference at position " + (start + 1));
            }
            if (!isValidTemplateRef(ref)) {
                throw new CnosError("cnos: invalid derivation template reference \"" + ref + "\"");
            }
            parts.add(ExprNode.ref(ref));
            cursor = end + 1;
        }

        if (parts.isEmpty()) return ExprNode.literal("");
        if (parts.size() == 1) return parts.get(0);
        return ExprNode.call("concat", parts);
    }

    private static ExprNode parseExpressionNode(ParserState state) throws CnosError {
        skipWhitespace(state);
        if (state.index >= state.source.length()) {
            throw state.error("Unexpected token");
        }
        char c = state.source.charAt(state.index);
        if (c == '\'') return parseStringLiteral(state);
        if (c >= '0' && c <= '9') return parseNumberLiteral(state);
        if (isIdentifierStart(c)) return parseIdentifierOrCall(state);
        throw state.error("Unexpected token");
    }

    private static ExprNode parseStringLiteral(ParserState state) throws CnosError {
        state.index++; // skip opening quote
        StringBuilder sb = new StringBuilder();
        while (state.index < state.source.length()) {
            char c = state.source.charAt(state.index);
            if (c == '\\') {
                if (state.index + 1 >= state.source.length()) {
                    throw state.error("Unterminated escape sequence");
                }
                sb.append(state.source.charAt(state.index + 1));
                state.index += 2;
                continue;
            }
            if (c == '\'') {
                state.index++;
                return ExprNode.literal(sb.toString());
            }
            sb.append(c);
            state.index++;
        }
        throw state.error("Unterminated string literal");
    }

    private static ExprNode parseNumberLiteral(ParserState state) throws CnosError {
        int start = state.index;
        while (state.index < state.source.length()
                && state.source.charAt(state.index) >= '0'
                && state.source.charAt(state.index) <= '9') {
            state.index++;
        }
        if (state.index < state.source.length() && state.source.charAt(state.index) == '.') {
            state.index++;
            while (state.index < state.source.length()
                    && state.source.charAt(state.index) >= '0'
                    && state.source.charAt(state.index) <= '9') {
                state.index++;
            }
        }
        String numStr = state.source.substring(start, state.index);
        try {
            return ExprNode.literal(Double.parseDouble(numStr));
        } catch (NumberFormatException e) {
            throw state.error("Invalid number literal");
        }
    }

    private static ExprNode parseIdentifierOrCall(ParserState state) throws CnosError {
        String identifier = parseIdentifier(state);
        skipWhitespace(state);
        if (state.index < state.source.length() && state.source.charAt(state.index) == '(') {
            if (!BUILTINS.contains(identifier)) {
                throw new CnosError("cnos: unknown derive function: " + identifier);
            }
            state.index++; // skip '('
            List<ExprNode> args = parseArguments(state);
            return ExprNode.call(identifier, args);
        }
        switch (identifier) {
            case "true": return ExprNode.literal(Boolean.TRUE);
            case "false": return ExprNode.literal(Boolean.FALSE);
            case "null": return ExprNode.literal(null);
            default: return ExprNode.ref(identifier);
        }
    }

    private static String parseIdentifier(ParserState state) throws CnosError {
        if (state.index >= state.source.length() || !isIdentifierStart(state.source.charAt(state.index))) {
            throw state.error("Expected identifier");
        }
        int start = state.index++;
        while (state.index < state.source.length() && isIdentifierPart(state.source.charAt(state.index))) {
            state.index++;
        }
        return state.source.substring(start, state.index);
    }

    private static List<ExprNode> parseArguments(ParserState state) throws CnosError {
        List<ExprNode> args = new ArrayList<>();
        skipWhitespace(state);
        if (state.index < state.source.length() && state.source.charAt(state.index) == ')') {
            state.index++;
            return args;
        }
        while (state.index < state.source.length()) {
            args.add(parseExpressionNode(state));
            skipWhitespace(state);
            if (state.index >= state.source.length()) break;
            char c = state.source.charAt(state.index);
            if (c == ',') {
                state.index++;
                skipWhitespace(state);
            } else if (c == ')') {
                state.index++;
                return args;
            } else {
                throw state.error("Expected \",\" or \")\"");
            }
        }
        throw state.error("Unterminated function call");
    }

    public static List<String> extractRefs(ExprNode node, List<String> refs) {
        if ("ref".equals(node.getKind())) {
            refs.add(node.getPath());
        } else if ("call".equals(node.getKind())) {
            for (ExprNode arg : node.getArgs()) {
                extractRefs(arg, refs);
            }
        }
        return refs;
    }

    private static void skipWhitespace(ParserState state) {
        while (state.index < state.source.length()) {
            char c = state.source.charAt(state.index);
            if (c == ' ' || c == '\n' || c == '\r' || c == '\t') {
                state.index++;
            } else {
                break;
            }
        }
    }

    private static boolean isIdentifierStart(char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
    }

    private static boolean isIdentifierPart(char c) {
        return isIdentifierStart(c) || (c >= '0' && c <= '9') || c == '.' || c == '-';
    }

    private static boolean isValidTemplateRef(String ref) {
        if (ref.isEmpty() || !isIdentifierStart(ref.charAt(0))) return false;
        for (int i = 1; i < ref.length(); i++) {
            if (!isIdentifierPart(ref.charAt(i))) return false;
        }
        return true;
    }

    public static List<String> uniqueSorted(List<String> values) {
        Set<String> seen = new HashSet<>();
        List<String> unique = new ArrayList<>();
        for (String v : values) {
            if (v != null && !v.isEmpty() && seen.add(v)) {
                unique.add(v);
            }
        }
        java.util.Collections.sort(unique);
        return unique;
    }

    /** Mutable parser cursor state. */
    private static final class ParserState {
        final String source;
        int index;

        ParserState(String source) {
            this.source = source;
            this.index = 0;
        }

        CnosError error(String message) {
            return new CnosError("cnos: " + message + " at position " + (index + 1));
        }
    }
}
