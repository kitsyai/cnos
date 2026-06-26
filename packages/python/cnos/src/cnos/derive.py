"""Derived formula parser and evaluator — mirrors Go's derive.go exactly."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from cnos.errors import CnosError
from cnos.jscompat import js_stringify_value, js_strict_equal
from cnos.types import DerivedFormula


# ---------------------------------------------------------------------------
# AST node
# ---------------------------------------------------------------------------

@dataclass
class ExprNode:
    kind: str = ""        # "literal" | "ref" | "call"
    value: Any = None     # for kind="literal"
    path: str = ""        # for kind="ref"
    name: str = ""        # for kind="call"
    args: List["ExprNode"] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Parsed formula (internal)
# ---------------------------------------------------------------------------

@dataclass
class ParsedFormula:
    raw: str = ""
    refs: List[str] = field(default_factory=list)
    deps: List[str] = field(default_factory=list)
    runtime_refs: List[str] = field(default_factory=list)
    runtime_dependent: bool = False
    ast: Optional[ExprNode] = None


_DERIVE_BUILTINS: Set[str] = {"concat", "coalesce", "when", "exists", "eq", "ne"}


# ---------------------------------------------------------------------------
# Parser state
# ---------------------------------------------------------------------------

class _ParserState:
    def __init__(self, source: str) -> None:
        self.source = source
        self.index = 0

    def errorf(self, message: str) -> CnosError:
        return CnosError(f"cnos: {message} at position {self.index + 1}")


def _is_whitespace(ch: str) -> bool:
    return ch in " \n\r\t"


def _skip_whitespace(state: _ParserState) -> None:
    while state.index < len(state.source) and _is_whitespace(state.source[state.index]):
        state.index += 1


def _is_identifier_start(ch: str) -> bool:
    return ch.isalpha() or ch == "_"


def _is_identifier_part(ch: str) -> bool:
    return ch.isalpha() or ch.isdigit() or ch in "._-"


def _is_valid_template_ref(value: str) -> bool:
    if not value or not _is_identifier_start(value[0]):
        return False
    for ch in value[1:]:
        if not _is_identifier_part(ch):
            return False
    return True


# ---------------------------------------------------------------------------
# Parser functions
# ---------------------------------------------------------------------------

def _parse_string_literal(state: _ParserState) -> ExprNode:
    state.index += 1  # consume opening '
    chars: List[str] = []
    while state.index < len(state.source):
        ch = state.source[state.index]
        if ch == "\\":
            if state.index + 1 >= len(state.source):
                raise state.errorf("Unterminated escape sequence")
            chars.append(state.source[state.index + 1])
            state.index += 2
            continue
        if ch == "'":
            state.index += 1
            return ExprNode(kind="literal", value="".join(chars))
        chars.append(ch)
        state.index += 1
    raise state.errorf("Unterminated string literal")


def _parse_number_literal(state: _ParserState) -> ExprNode:
    start = state.index
    while state.index < len(state.source) and state.source[state.index].isdigit():
        state.index += 1
    if state.index < len(state.source) and state.source[state.index] == ".":
        state.index += 1
        while state.index < len(state.source) and state.source[state.index].isdigit():
            state.index += 1
    raw = state.source[start:state.index]
    try:
        return ExprNode(kind="literal", value=float(raw))
    except ValueError as exc:
        raise CnosError(f"cnos: invalid number literal: {raw}") from exc


def _parse_identifier(state: _ParserState) -> str:
    if state.index >= len(state.source) or not _is_identifier_start(state.source[state.index]):
        raise state.errorf("Expected identifier")
    start = state.index
    state.index += 1
    while state.index < len(state.source) and _is_identifier_part(state.source[state.index]):
        state.index += 1
    return state.source[start:state.index]


def _parse_arguments(state: _ParserState) -> List[ExprNode]:
    args: List[ExprNode] = []
    _skip_whitespace(state)
    if state.index < len(state.source) and state.source[state.index] == ")":
        state.index += 1
        return args
    while state.index < len(state.source):
        node = _parse_expression_node(state)
        args.append(node)
        _skip_whitespace(state)
        if state.index >= len(state.source):
            break
        ch = state.source[state.index]
        if ch == ",":
            state.index += 1
            _skip_whitespace(state)
        elif ch == ")":
            state.index += 1
            return args
        else:
            raise state.errorf('Expected "," or ")"')
    raise state.errorf("Unterminated function call")


def _parse_identifier_or_call(state: _ParserState) -> ExprNode:
    identifier = _parse_identifier(state)
    _skip_whitespace(state)
    if state.index < len(state.source) and state.source[state.index] == "(":
        if identifier not in _DERIVE_BUILTINS:
            raise CnosError(f"cnos: unknown derive function: {identifier}")
        state.index += 1  # consume '('
        args = _parse_arguments(state)
        return ExprNode(kind="call", name=identifier, args=args)
    # keywords or ref
    if identifier == "true":
        return ExprNode(kind="literal", value=True)
    if identifier == "false":
        return ExprNode(kind="literal", value=False)
    if identifier == "null":
        return ExprNode(kind="literal", value=None)
    return ExprNode(kind="ref", path=identifier)


def _parse_expression_node(state: _ParserState) -> ExprNode:
    _skip_whitespace(state)
    if state.index >= len(state.source):
        raise state.errorf("Unexpected token")
    ch = state.source[state.index]
    if ch == "'":
        return _parse_string_literal(state)
    if ch.isdigit():
        return _parse_number_literal(state)
    if _is_identifier_start(ch):
        return _parse_identifier_or_call(state)
    raise state.errorf("Unexpected token")


def _parse_template(source: str) -> ExprNode:
    parts: List[ExprNode] = []
    cursor = 0
    while cursor < len(source):
        start = source.find("${", cursor)
        if start == -1:
            if cursor < len(source):
                parts.append(ExprNode(kind="literal", value=source[cursor:]))
            break
        if start > cursor:
            parts.append(ExprNode(kind="literal", value=source[cursor:start]))
        end = source.find("}", start + 2)
        if end == -1:
            raise CnosError(
                f"cnos: invalid derivation template: unclosed ${{...}} at position {start + 1}"
            )
        ref = source[start + 2:end].strip()
        if not ref:
            raise CnosError(
                f"cnos: invalid derivation template: empty reference at position {start + 1}"
            )
        if not _is_valid_template_ref(ref):
            raise CnosError(
                f"cnos: invalid derivation template reference {ref!r}"
            )
        parts.append(ExprNode(kind="ref", path=ref))
        cursor = end + 1

    if not parts:
        return ExprNode(kind="literal", value="")
    if len(parts) == 1:
        return parts[0]
    return ExprNode(kind="call", name="concat", args=parts)


def parse_derived_source(source: str) -> ExprNode:
    if "${" in source:
        return _parse_template(source)
    state = _ParserState(source)
    node = _parse_expression_node(state)
    _skip_whitespace(state)
    if state.index != len(state.source):
        raise state.errorf("Unexpected trailing input")
    return node


def parse_derived_formula(formula: DerivedFormula) -> ParsedFormula:
    ast = parse_derived_source(formula.expr)
    refs = list(formula.deps) + list(formula.runtime_refs)
    unique_refs = _unique_sorted(refs)
    return ParsedFormula(
        raw=formula.expr,
        refs=unique_refs,
        deps=list(formula.deps),
        runtime_refs=list(formula.runtime_refs),
        runtime_dependent=len(formula.runtime_refs) > 0,
        ast=ast,
    )


def parse_raw_derived_value(value: Any) -> ParsedFormula:
    """Parse a $derive value from a graph entry."""
    source = _derive_source_from_value(value)
    ast = parse_derived_source(source)
    refs = _extract_refs(ast, [])
    unique_refs = _unique_sorted(refs)
    return ParsedFormula(
        raw=source,
        refs=unique_refs,
        deps=unique_refs,
        ast=ast,
    )


def _derive_source_from_value(value: Any) -> str:
    if not isinstance(value, dict):
        raise CnosError(
            "cnos: derived value requires either a template string or { expr } object"
        )
    raw = value.get("$derive")
    if raw is None:
        raise CnosError(
            "cnos: derived value requires either a template string or { expr } object"
        )
    if isinstance(raw, str):
        return raw
    if isinstance(raw, dict):
        source = raw.get("expr", "")
        if not isinstance(source, str) or not source.strip():
            raise CnosError(
                "cnos: derived value requires either a template string or { expr } object"
            )
        return source
    raise CnosError("cnos: derived value requires either a template string or { expr } object")


def is_derived_value(value: Any) -> bool:
    return isinstance(value, dict) and "$derive" in value


def _extract_refs(node: ExprNode, refs: List[str]) -> List[str]:
    if node.kind == "ref":
        refs.append(node.path)
    elif node.kind == "call":
        for arg in node.args:
            refs = _extract_refs(arg, refs)
    return refs


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------

ResolveRef = Callable[[str], Tuple[Any, bool]]


def evaluate_derived_formula(
    key: str,
    formula: ParsedFormula,
    resolve_ref: ResolveRef,
) -> Any:
    value, found, err = _evaluate_node(formula.ast, resolve_ref)
    if err:
        raise CnosError(err)
    if formula.ast is not None and formula.ast.kind == "ref" and not found:
        raise CnosError(
            f"cnos: unable to resolve derived config key {key} because {formula.ast.path} is missing"
        )
    return value


def _evaluate_node(
    node: ExprNode,
    resolve_ref: ResolveRef,
) -> Tuple[Any, bool, Optional[str]]:
    if node.kind == "literal":
        return node.value, True, None
    if node.kind == "ref":
        val, found = resolve_ref(node.path)
        return val, found, None
    if node.kind == "call":
        values: List[Any] = []
        flags: List[bool] = []
        for arg in node.args:
            val, found, err = _evaluate_node(arg, resolve_ref)
            if err:
                return None, False, err
            values.append(val)
            flags.append(found)
        val, found, err = _evaluate_call(node.name, values, flags)
        return val, found, err
    return None, False, f"cnos: unsupported derive AST node {node.kind!r}"


def _evaluate_call(
    name: str, values: List[Any], flags: List[bool]
) -> Tuple[Any, bool, Optional[str]]:
    if name == "concat":
        parts = [js_stringify_value(v) for v in values]
        return "".join(parts), True, None
    if name == "coalesce":
        for v in values:
            if v is not None:
                return v, True, None
        return None, True, None
    if name == "when":
        when_true = values[1] if len(values) > 1 else None
        when_false = values[2] if len(values) > 2 else None
        if _is_truthy(values[0] if values else None):
            return when_true, True, None
        return when_false, True, None
    if name == "exists":
        if not values:
            return False, True, None
        return (flags[0] and values[0] is not None), True, None
    if name == "eq":
        left = values[0] if values else None
        right = values[1] if len(values) > 1 else None
        return js_strict_equal(left, right), True, None
    if name == "ne":
        left = values[0] if values else None
        right = values[1] if len(values) > 1 else None
        return not js_strict_equal(left, right), True, None
    return None, False, f"cnos: unknown derive function: {name}"


def _is_truthy(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return bool(value)
    if isinstance(value, (int, float)):
        return value != 0
    return True


def _unique_sorted(values: List[str]) -> List[str]:
    seen: Set[str] = set()
    result: List[str] = []
    for v in values:
        if v and v not in seen:
            seen.add(v)
            result.append(v)
    return sorted(result)


def formula_type(formula: Optional[ParsedFormula]) -> str:
    if formula is None:
        return ""
    if formula.raw and "${" in formula.raw:
        return "template"
    return "expression"
