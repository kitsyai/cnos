"""Tests for the derive formula parser and evaluator."""
from __future__ import annotations

import pytest

from cnos.derive import (
    ParsedFormula,
    _unique_sorted,
    evaluate_derived_formula,
    is_derived_value,
    parse_derived_formula,
    parse_derived_source,
    parse_raw_derived_value,
)
from cnos.errors import CnosError
from cnos.types import DerivedFormula


# ---------------------------------------------------------------------------
# Template parsing
# ---------------------------------------------------------------------------

class TestTemplateParsing:
    def test_simple_template(self):
        ast = parse_derived_source("Hello ${value.name}!")
        assert ast.kind == "call"
        assert ast.name == "concat"
        assert len(ast.args) == 3
        assert ast.args[0].kind == "literal"
        assert ast.args[0].value == "Hello "
        assert ast.args[1].kind == "ref"
        assert ast.args[1].path == "value.name"
        assert ast.args[2].kind == "literal"
        assert ast.args[2].value == "!"

    def test_single_ref_template(self):
        # A single ref template is unwrapped to just a ref node
        ast = parse_derived_source("${value.host}")
        assert ast.kind == "ref"
        assert ast.path == "value.host"

    def test_empty_template_string(self):
        with pytest.raises(CnosError, match="Unexpected token"):
            parse_derived_source("")
        with pytest.raises(CnosError, match="Unexpected trailing input"):
            parse_derived_source("no refs here")

    def test_unclosed_template(self):
        with pytest.raises(CnosError, match="unclosed"):
            parse_derived_source("prefix ${value.x")

    def test_empty_ref_template(self):
        with pytest.raises(CnosError, match="empty reference"):
            parse_derived_source("${}")

    def test_invalid_ref_template(self):
        with pytest.raises(CnosError, match="invalid derivation template reference"):
            parse_derived_source("${ 123bad }")

    def test_multiple_refs(self):
        ast = parse_derived_source("${value.host}:${value.port}")
        assert ast.kind == "call"
        assert ast.name == "concat"
        assert len(ast.args) == 3
        assert ast.args[0].kind == "ref"
        assert ast.args[0].path == "value.host"
        assert ast.args[1].kind == "literal"
        assert ast.args[1].value == ":"
        assert ast.args[2].kind == "ref"
        assert ast.args[2].path == "value.port"


# ---------------------------------------------------------------------------
# Expression parsing
# ---------------------------------------------------------------------------

class TestExpressionParsing:
    def test_string_literal(self):
        ast = parse_derived_source("'hello world'")
        assert ast.kind == "literal"
        assert ast.value == "hello world"

    def test_number_literal(self):
        ast = parse_derived_source("42")
        assert ast.kind == "literal"
        assert ast.value == 42.0

    def test_float_literal(self):
        ast = parse_derived_source("3.14")
        assert ast.kind == "literal"
        assert abs(ast.value - 3.14) < 1e-10

    def test_true_literal(self):
        ast = parse_derived_source("true")
        assert ast.kind == "literal"
        assert ast.value is True

    def test_false_literal(self):
        ast = parse_derived_source("false")
        assert ast.kind == "literal"
        assert ast.value is False

    def test_null_literal(self):
        ast = parse_derived_source("null")
        assert ast.kind == "literal"
        assert ast.value is None

    def test_bare_ref(self):
        ast = parse_derived_source("value.port")
        assert ast.kind == "ref"
        assert ast.path == "value.port"

    def test_string_escape(self):
        ast = parse_derived_source(r"'it\'s here'")
        assert ast.kind == "literal"
        assert ast.value == "it's here"

    def test_concat_call(self):
        ast = parse_derived_source("concat('a', 'b')")
        assert ast.kind == "call"
        assert ast.name == "concat"
        assert len(ast.args) == 2

    def test_coalesce_call(self):
        ast = parse_derived_source("coalesce(value.x, 'default')")
        assert ast.kind == "call"
        assert ast.name == "coalesce"

    def test_when_call(self):
        ast = parse_derived_source("when(value.flag, 'yes', 'no')")
        assert ast.kind == "call"
        assert ast.name == "when"
        assert len(ast.args) == 3

    def test_exists_call(self):
        ast = parse_derived_source("exists(value.x)")
        assert ast.kind == "call"
        assert ast.name == "exists"

    def test_eq_call(self):
        ast = parse_derived_source("eq(value.x, 'prod')")
        assert ast.kind == "call"
        assert ast.name == "eq"

    def test_ne_call(self):
        ast = parse_derived_source("ne(value.x, 'prod')")
        assert ast.kind == "call"
        assert ast.name == "ne"

    def test_unknown_function(self):
        with pytest.raises(CnosError, match="unknown derive function"):
            parse_derived_source("unknown()")

    def test_trailing_input(self):
        with pytest.raises(CnosError, match="Unexpected trailing input"):
            parse_derived_source("'a' 'b'")


# ---------------------------------------------------------------------------
# Evaluation — all 6 built-in functions
# ---------------------------------------------------------------------------

def _make_formula(expr: str, deps=None, runtime_refs=None) -> ParsedFormula:
    df = DerivedFormula(expr=expr, deps=deps or [], runtime_refs=runtime_refs or [])
    return parse_derived_formula(df)


def _resolve(lookup: dict):
    def resolve_ref(ref):
        if ref in lookup:
            return lookup[ref], True
        return None, False
    return resolve_ref


class TestConcat:
    def test_concat_strings(self):
        formula = _make_formula("concat('hello', ' ', 'world')")
        result = evaluate_derived_formula("key", formula, _resolve({}))
        assert result == "hello world"

    def test_concat_with_ref(self):
        formula = _make_formula("concat(value.host, ':', value.port)")
        result = evaluate_derived_formula("key", formula, _resolve({
            "value.host": "localhost",
            "value.port": 5432,
        }))
        assert result == "localhost:5432"

    def test_template_concat(self):
        formula = _make_formula("${value.host}:${value.port}")
        result = evaluate_derived_formula("key", formula, _resolve({
            "value.host": "db",
            "value.port": 5432,
        }))
        assert result == "db:5432"

    def test_concat_none_becomes_empty(self):
        formula = _make_formula("concat('prefix-', value.x)")
        result = evaluate_derived_formula("key", formula, _resolve({"value.x": None}))
        assert result == "prefix-"


class TestCoalesce:
    def test_returns_first_non_null(self):
        formula = _make_formula("coalesce(value.a, value.b, 'default')")
        result = evaluate_derived_formula("key", formula, _resolve({
            "value.a": None, "value.b": "found",
        }))
        assert result == "found"

    def test_all_null_returns_null(self):
        formula = _make_formula("coalesce(value.a, value.b)")
        result = evaluate_derived_formula("key", formula, _resolve({
            "value.a": None, "value.b": None,
        }))
        assert result is None

    def test_first_value_wins(self):
        formula = _make_formula("coalesce(value.a, value.b)")
        result = evaluate_derived_formula("key", formula, _resolve({
            "value.a": "first", "value.b": "second",
        }))
        assert result == "first"


class TestWhen:
    def test_truthy_condition(self):
        formula = _make_formula("when(value.flag, 'yes', 'no')")
        result = evaluate_derived_formula("key", formula, _resolve({"value.flag": True}))
        assert result == "yes"

    def test_falsy_condition(self):
        formula = _make_formula("when(value.flag, 'yes', 'no')")
        result = evaluate_derived_formula("key", formula, _resolve({"value.flag": False}))
        assert result == "no"

    def test_none_is_falsy(self):
        formula = _make_formula("when(value.x, 'yes', 'no')")
        result = evaluate_derived_formula("key", formula, _resolve({"value.x": None}))
        assert result == "no"

    def test_empty_string_is_falsy(self):
        formula = _make_formula("when(value.x, 'yes', 'no')")
        result = evaluate_derived_formula("key", formula, _resolve({"value.x": ""}))
        assert result == "no"

    def test_non_empty_string_is_truthy(self):
        formula = _make_formula("when(value.x, 'yes', 'no')")
        result = evaluate_derived_formula("key", formula, _resolve({"value.x": "something"}))
        assert result == "yes"


class TestExists:
    def test_key_exists(self):
        formula = _make_formula("exists(value.x)")
        result = evaluate_derived_formula("key", formula, _resolve({"value.x": "val"}))
        assert result is True

    def test_key_missing(self):
        formula = _make_formula("exists(value.x)")
        result = evaluate_derived_formula("key", formula, _resolve({}))
        assert result is False

    def test_key_null_not_exists(self):
        formula = _make_formula("exists(value.x)")
        result = evaluate_derived_formula("key", formula, _resolve({"value.x": None}))
        assert result is False


class TestEqNe:
    def test_eq_equal_strings(self):
        formula = _make_formula("eq(value.env, 'prod')")
        result = evaluate_derived_formula("key", formula, _resolve({"value.env": "prod"}))
        assert result is True

    def test_eq_unequal(self):
        formula = _make_formula("eq(value.env, 'prod')")
        result = evaluate_derived_formula("key", formula, _resolve({"value.env": "dev"}))
        assert result is False

    def test_ne_unequal(self):
        formula = _make_formula("ne(value.env, 'prod')")
        result = evaluate_derived_formula("key", formula, _resolve({"value.env": "dev"}))
        assert result is True

    def test_eq_numbers(self):
        formula = _make_formula("eq(value.port, value.other)")
        result = evaluate_derived_formula("key", formula, _resolve({"value.port": 8080, "value.other": 8080}))
        assert result is True

    def test_eq_nan_not_equal(self):
        import math
        formula = _make_formula("eq(value.x, value.x)")
        result = evaluate_derived_formula("key", formula, _resolve({"value.x": float("nan")}))
        assert result is False


# ---------------------------------------------------------------------------
# Cycle detection
# ---------------------------------------------------------------------------

class TestCycleDetection:
    def test_direct_cycle(self):
        from cnos.runtime import CnosRuntime, new_runtime
        from cnos.env import Environment

        # Build a projection where value.a derives from value.a
        import json
        proj = {
            "version": 1,
            "workspace": "default",
            "profile": "base",
            "resolvedAt": "2024-01-01T00:00:00Z",
            "configHash": "abc",
            "values": {},
            "derived": {
                "server.url": {
                    "expr": "${value.server.url}",
                    "deps": ["value.server.url"],
                    "runtimeRefs": [],
                }
            },
            "secretRefs": {},
            "publicKeys": [],
            "meta": {
                "workspace": "default",
                "profile": "base",
                "cnos_version": "1.0.0",
            },
        }
        with pytest.raises(CnosError, match="recursive dependency"):
            new_runtime(json.dumps(proj).encode(), Environment(), "/tmp/secrets", [])


# ---------------------------------------------------------------------------
# Runtime-dependent detection
# ---------------------------------------------------------------------------

class TestRuntimeDependentDetection:
    def test_runtime_ref_makes_dependent(self):
        df = DerivedFormula(
            expr="${request.user}",
            deps=[],
            runtime_refs=["request.user"],
        )
        formula = parse_derived_formula(df)
        assert formula.runtime_dependent is True

    def test_no_runtime_refs(self):
        df = DerivedFormula(
            expr="${value.host}",
            deps=["value.host"],
            runtime_refs=[],
        )
        formula = parse_derived_formula(df)
        assert formula.runtime_dependent is False

    def test_is_derived_value(self):
        assert is_derived_value({"$derive": "concat('a', 'b')"})
        assert not is_derived_value({"ref": "some-secret"})
        assert not is_derived_value("plain string")

    def test_parse_raw_derived_value_string(self):
        formula = parse_raw_derived_value({"$derive": "${value.host}"})
        assert formula.raw == "${value.host}"
        assert "value.host" in formula.refs

    def test_parse_raw_derived_value_expr(self):
        formula = parse_raw_derived_value({"$derive": {"expr": "concat(value.a, value.b)"}})
        assert "value.a" in formula.refs
        assert "value.b" in formula.refs
