package ai.kitsy.cnos;

import ai.kitsy.cnos.internal.*;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class FormulaParserTest {

    // ---- Template mode ----

    @Test
    void parseSimpleTemplate() throws CnosError {
        ExprNode ast = FormulaParser.parseDerivedSource("${value.host}:${value.port}");
        assertEquals("call", ast.getKind());
        assertEquals("concat", ast.getName());
        assertEquals(3, ast.getArgs().size());
        assertEquals("ref", ast.getArgs().get(0).getKind());
        assertEquals("value.host", ast.getArgs().get(0).getPath());
        assertEquals("literal", ast.getArgs().get(1).getKind());
        assertEquals(":", ast.getArgs().get(1).getValue());
        assertEquals("ref", ast.getArgs().get(2).getKind());
        assertEquals("value.port", ast.getArgs().get(2).getPath());
    }

    @Test
    void parseSingleRefTemplate() throws CnosError {
        ExprNode ast = FormulaParser.parseDerivedSource("${value.host}");
        // Single part — should be a bare ref, not wrapped in concat
        assertEquals("ref", ast.getKind());
        assertEquals("value.host", ast.getPath());
    }

    @Test
    void parseLiteralOnlyTemplate() {
        // "hello world" doesn't contain "${", so it goes through the expression parser.
        // "hello" is a valid identifier, but " world" is trailing input — the parser should throw.
        assertThrows(CnosError.class, () -> FormulaParser.parseDerivedSource("hello world"));
    }

    @Test
    void parseStringLiteralExpression() throws CnosError {
        ExprNode ast = FormulaParser.parseDerivedSource("'hello'");
        assertEquals("literal", ast.getKind());
        assertEquals("hello", ast.getValue());
    }

    @Test
    void parseNumberLiteralExpression() throws CnosError {
        ExprNode ast = FormulaParser.parseDerivedSource("42");
        assertEquals("literal", ast.getKind());
        assertEquals(42.0, ast.getValue());
    }

    @Test
    void parseTrueExpression() throws CnosError {
        ExprNode ast = FormulaParser.parseDerivedSource("true");
        assertEquals("literal", ast.getKind());
        assertEquals(Boolean.TRUE, ast.getValue());
    }

    @Test
    void parseFalseExpression() throws CnosError {
        ExprNode ast = FormulaParser.parseDerivedSource("false");
        assertEquals("literal", ast.getKind());
        assertEquals(Boolean.FALSE, ast.getValue());
    }

    @Test
    void parseNullExpression() throws CnosError {
        ExprNode ast = FormulaParser.parseDerivedSource("null");
        assertEquals("literal", ast.getKind());
        assertNull(ast.getValue());
    }

    // ---- Expression functions ----

    @Test
    void parseConcatCall() throws CnosError {
        ExprNode ast = FormulaParser.parseDerivedSource("concat(value.a, 'x', value.b)");
        assertEquals("call", ast.getKind());
        assertEquals("concat", ast.getName());
        assertEquals(3, ast.getArgs().size());
    }

    @Test
    void parseCoalesceCall() throws CnosError {
        ExprNode ast = FormulaParser.parseDerivedSource("coalesce(value.a, value.b, 'default')");
        assertEquals("call", ast.getKind());
        assertEquals("coalesce", ast.getName());
        assertEquals(3, ast.getArgs().size());
    }

    @Test
    void parseWhenCall() throws CnosError {
        ExprNode ast = FormulaParser.parseDerivedSource("when(value.flag, 'yes', 'no')");
        assertEquals("call", ast.getKind());
        assertEquals("when", ast.getName());
        assertEquals(3, ast.getArgs().size());
    }

    @Test
    void parseExistsCall() throws CnosError {
        ExprNode ast = FormulaParser.parseDerivedSource("exists(value.key)");
        assertEquals("call", ast.getKind());
        assertEquals("exists", ast.getName());
        assertEquals(1, ast.getArgs().size());
    }

    @Test
    void parseEqCall() throws CnosError {
        ExprNode ast = FormulaParser.parseDerivedSource("eq(value.env, 'prod')");
        assertEquals("call", ast.getKind());
        assertEquals("eq", ast.getName());
    }

    @Test
    void parseNeCall() throws CnosError {
        ExprNode ast = FormulaParser.parseDerivedSource("ne(value.env, 'dev')");
        assertEquals("call", ast.getKind());
        assertEquals("ne", ast.getName());
    }

    @Test
    void unknownFunctionThrows() {
        assertThrows(CnosError.class, () -> FormulaParser.parseDerivedSource("unknown(a)"));
    }

    @Test
    void unclosedTemplateThrows() {
        assertThrows(CnosError.class, () -> FormulaParser.parseDerivedSource("prefix ${unclosed"));
    }

    @Test
    void emptyTemplateRefThrows() {
        assertThrows(CnosError.class, () -> FormulaParser.parseDerivedSource("${  }"));
    }

    // ---- Evaluation ----

    @Test
    void evaluateConcatTemplate() throws CnosError {
        ParsedFormula formula = FormulaParser.parseDerivedSource(
                "${value.host}:${value.port}") != null
                ? buildFormula("${value.host}:${value.port}")
                : null;
        assertNotNull(formula);

        Map<String, Object> values = new HashMap<>();
        values.put("value.host", "localhost");
        values.put("value.port", 8080);

        Object result = FormulaEvaluator.evaluate("test.key", formula, ref -> {
            Object v = values.get(ref);
            return new Object[]{v, v != null};
        });
        assertEquals("localhost:8080", result);
    }

    @Test
    void evaluateCoalesce() throws CnosError {
        ParsedFormula formula = buildFormula("coalesce(value.a, value.b, 'fallback')");
        Map<String, Object> values = new HashMap<>();
        values.put("value.a", null);
        values.put("value.b", "found");

        Object result = FormulaEvaluator.evaluate("test.key", formula, ref -> {
            Object v = values.get(ref);
            return new Object[]{v, values.containsKey(ref)};
        });
        assertEquals("found", result);
    }

    @Test
    void evaluateWhenTrue() throws CnosError {
        ParsedFormula formula = buildFormula("when(value.flag, 'yes', 'no')");
        Object result = FormulaEvaluator.evaluate("test.key", formula, ref -> {
            if ("value.flag".equals(ref)) return new Object[]{Boolean.TRUE, Boolean.TRUE};
            return new Object[]{null, Boolean.FALSE};
        });
        assertEquals("yes", result);
    }

    @Test
    void evaluateWhenFalse() throws CnosError {
        ParsedFormula formula = buildFormula("when(value.flag, 'yes', 'no')");
        Object result = FormulaEvaluator.evaluate("test.key", formula, ref -> {
            if ("value.flag".equals(ref)) return new Object[]{Boolean.FALSE, Boolean.TRUE};
            return new Object[]{null, Boolean.FALSE};
        });
        assertEquals("no", result);
    }

    @Test
    void evaluateExistsTrue() throws CnosError {
        ParsedFormula formula = buildFormula("exists(value.key)");
        Object result = FormulaEvaluator.evaluate("test.key", formula, ref ->
                new Object[]{"someValue", Boolean.TRUE});
        assertEquals(Boolean.TRUE, result);
    }

    @Test
    void evaluateExistsFalse() throws CnosError {
        ParsedFormula formula = buildFormula("exists(value.key)");
        Object result = FormulaEvaluator.evaluate("test.key", formula, ref ->
                new Object[]{null, Boolean.FALSE});
        assertEquals(Boolean.FALSE, result);
    }

    @Test
    void evaluateEqTrue() throws CnosError {
        ParsedFormula formula = buildFormula("eq(value.env, 'prod')");
        Object result = FormulaEvaluator.evaluate("test.key", formula, ref -> {
            if ("value.env".equals(ref)) return new Object[]{"prod", Boolean.TRUE};
            return new Object[]{"prod", Boolean.TRUE};
        });
        assertEquals(Boolean.TRUE, result);
    }

    @Test
    void evaluateNeTrue() throws CnosError {
        ParsedFormula formula = buildFormula("ne(value.env, 'prod')");
        Object result = FormulaEvaluator.evaluate("test.key", formula, ref -> {
            if ("value.env".equals(ref)) return new Object[]{"dev", Boolean.TRUE};
            return new Object[]{"prod", Boolean.TRUE};
        });
        assertEquals(Boolean.TRUE, result);
    }

    // ---- Cycle detection (via CnosRuntime) ----

    @Test
    void cyclicDependencyThrows() {
        String cycleProjection = "{"
                + "\"version\":1,"
                + "\"workspace\":\"base\","
                + "\"profile\":\"local\","
                + "\"resolvedAt\":\"2024-01-01T00:00:00Z\","
                + "\"configHash\":\"abc\","
                + "\"values\":{},"
                + "\"derived\":{"
                + "  \"a\":{\"expr\":\"${value.b}\",\"deps\":[\"value.b\"],\"runtimeRefs\":[]},"
                + "  \"b\":{\"expr\":\"${value.a}\",\"deps\":[\"value.a\"],\"runtimeRefs\":[]}"
                + "},"
                + "\"secretRefs\":{},"
                + "\"publicKeys\":[],"
                + "\"runtimeNamespaces\":[],"
                + "\"meta\":{\"workspace\":\"base\",\"profile\":\"local\",\"cnos_version\":\"1.0\"}"
                + "}";
        // prepareDerivedEntries should detect the cycle and throw
        assertThrows(Exception.class, () ->
                CnosRuntime.load(CnosOptions.builder()
                        .projectionData(cycleProjection.getBytes(java.nio.charset.StandardCharsets.UTF_8))
                        .environment(Collections.emptyMap())
                        .build()));
    }

    // ---- Helpers ----

    private ParsedFormula buildFormula(String expr) throws CnosError {
        ExprNode ast = FormulaParser.parseDerivedSource(expr);
        List<String> refs = FormulaParser.uniqueSorted(FormulaParser.extractRefs(ast, new ArrayList<>()));
        return new ParsedFormula(expr, refs, refs, Collections.emptyList(), false, ast);
    }
}
