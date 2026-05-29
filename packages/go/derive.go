package cnos

import (
	"fmt"
	"strconv"
	"strings"
)

type exprNode struct {
	kind  string
	value any
	path  string
	name  string
	args  []exprNode
}

type parsedFormula struct {
	raw              string
	refs             []string
	deps             []string
	runtimeRefs      []string
	runtimeDependent bool
	ast              exprNode
}

type parserState struct {
	source string
	index  int
}

var deriveBuiltins = map[string]struct{}{
	"concat":   {},
	"coalesce": {},
	"when":     {},
	"exists":   {},
	"eq":       {},
	"ne":       {},
}

func parseDerivedFormula(formula DerivedFormula) (parsedFormula, error) {
	ast, err := parseDerivedSource(formula.Expr)
	if err != nil {
		return parsedFormula{}, err
	}

	refs := append([]string(nil), formula.Deps...)
	refs = append(refs, formula.RuntimeRefs...)

	return parsedFormula{
		raw:              formula.Expr,
		refs:             uniqueSortedStrings(refs),
		deps:             append([]string(nil), formula.Deps...),
		runtimeRefs:      append([]string(nil), formula.RuntimeRefs...),
		runtimeDependent: len(formula.RuntimeRefs) > 0,
		ast:              ast,
	}, nil
}

func parseRawDerivedValue(value any) (parsedFormula, error) {
	source, err := deriveSourceFromValue(value)
	if err != nil {
		return parsedFormula{}, err
	}

	ast, err := parseDerivedSource(source)
	if err != nil {
		return parsedFormula{}, err
	}

	refs := extractRefs(ast, nil)

	return parsedFormula{
		raw:  source,
		refs: uniqueSortedStrings(refs),
		deps: uniqueSortedStrings(refs),
		ast:  ast,
	}, nil
}

func deriveSourceFromValue(value any) (string, error) {
	document, ok := value.(map[string]any)
	if !ok {
		return "", fmt.Errorf("cnos: derived value requires either a template string or { expr } object")
	}

	raw, ok := document["$derive"]
	if !ok {
		return "", fmt.Errorf("cnos: derived value requires either a template string or { expr } object")
	}

	if source, ok := raw.(string); ok {
		return source, nil
	}

	deriveMap, ok := raw.(map[string]any)
	if !ok {
		return "", fmt.Errorf("cnos: derived value requires either a template string or { expr } object")
	}

	source, ok := deriveMap["expr"].(string)
	if !ok || strings.TrimSpace(source) == "" {
		return "", fmt.Errorf("cnos: derived value requires either a template string or { expr } object")
	}

	return source, nil
}

func isDerivedValue(value any) bool {
	document, ok := value.(map[string]any)
	if !ok {
		return false
	}

	_, ok = document["$derive"]
	return ok
}

func parseDerivedSource(source string) (exprNode, error) {
	if strings.Contains(source, "${") {
		return parseTemplate(source)
	}

	state := &parserState{source: source}
	node, err := parseExpressionNode(state)
	if err != nil {
		return exprNode{}, err
	}
	skipWhitespace(state)
	if state.index != len(state.source) {
		return exprNode{}, state.errorf("Unexpected trailing input")
	}
	return node, nil
}

func parseTemplate(source string) (exprNode, error) {
	parts := []exprNode{}
	cursor := 0

	for cursor < len(source) {
		start := strings.Index(source[cursor:], "${")
		if start < 0 {
			if cursor < len(source) {
				parts = append(parts, exprNode{kind: "literal", value: source[cursor:]})
			}
			break
		}

		start += cursor
		if start > cursor {
			parts = append(parts, exprNode{kind: "literal", value: source[cursor:start]})
		}

		end := strings.IndexByte(source[start+2:], '}')
		if end < 0 {
			return exprNode{}, fmt.Errorf("cnos: invalid derivation template: unclosed ${...} at position %d", start+1)
		}
		end += start + 2

		ref := strings.TrimSpace(source[start+2 : end])
		if ref == "" {
			return exprNode{}, fmt.Errorf("cnos: invalid derivation template: empty reference at position %d", start+1)
		}
		if !isValidTemplateRef(ref) {
			return exprNode{}, fmt.Errorf("cnos: invalid derivation template reference %q", ref)
		}

		parts = append(parts, exprNode{kind: "ref", path: ref})
		cursor = end + 1
	}

	if len(parts) == 0 {
		return exprNode{kind: "literal", value: ""}, nil
	}
	if len(parts) == 1 {
		return parts[0], nil
	}

	return exprNode{kind: "call", name: "concat", args: parts}, nil
}

func evaluateDerivedFormula(
	key string,
	formula parsedFormula,
	resolveRef func(string) (any, bool, error),
) (any, error) {
	value, found, err := evaluateNode(formula.ast, resolveRef)
	if err != nil {
		return nil, err
	}
	if formula.ast.kind == "ref" && !found {
		return nil, fmt.Errorf("cnos: unable to resolve derived config key %s because %s is missing", key, formula.ast.path)
	}
	return value, nil
}

func evaluateNode(
	node exprNode,
	resolveRef func(string) (any, bool, error),
) (any, bool, error) {
	switch node.kind {
	case "literal":
		return node.value, true, nil
	case "ref":
		return resolveRef(node.path)
	case "call":
		values := make([]any, len(node.args))
		flags := make([]bool, len(node.args))
		for index, arg := range node.args {
			value, found, err := evaluateNode(arg, resolveRef)
			if err != nil {
				return nil, false, err
			}
			values[index] = value
			flags[index] = found
		}
		return evaluateCall(node.name, values, flags)
	default:
		return nil, false, fmt.Errorf("cnos: unsupported derive AST node %q", node.kind)
	}
}

func evaluateCall(name string, values []any, flags []bool) (any, bool, error) {
	switch name {
	case "concat":
		parts := make([]string, len(values))
		for index, value := range values {
			parts[index] = normalizeConcatValue(value)
		}
		return strings.Join(parts, ""), true, nil
	case "coalesce":
		for _, value := range values {
			if value != nil {
				return value, true, nil
			}
		}
		return nil, true, nil
	case "when":
		var whenTrue, whenFalse any
		if len(values) > 1 {
			whenTrue = values[1]
		}
		if len(values) > 2 {
			whenFalse = values[2]
		}
		if isTruthy(values[0]) {
			return whenTrue, true, nil
		}
		return whenFalse, true, nil
	case "exists":
		if len(values) == 0 {
			return false, true, nil
		}
		return flags[0] && values[0] != nil, true, nil
	case "eq":
		return jsStrictEqual(valueAt(values, 0), valueAt(values, 1)), true, nil
	case "ne":
		return !jsStrictEqual(valueAt(values, 0), valueAt(values, 1)), true, nil
	default:
		return nil, false, fmt.Errorf("cnos: unknown derive function: %s", name)
	}
}

func valueAt(values []any, index int) any {
	if index >= 0 && index < len(values) {
		return values[index]
	}
	return nil
}

func normalizeConcatValue(value any) string {
	return jsStringifyValue(value)
}

func extractRefs(node exprNode, refs []string) []string {
	switch node.kind {
	case "ref":
		return append(refs, node.path)
	case "call":
		for _, arg := range node.args {
			refs = extractRefs(arg, refs)
		}
	}

	return refs
}

func isTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0
	case float32:
		return typed != 0
	case int:
		return typed != 0
	case int64:
		return typed != 0
	case int32:
		return typed != 0
	case uint:
		return typed != 0
	case uint64:
		return typed != 0
	case uint32:
		return typed != 0
	default:
		return true
	}
}

func isWhitespace(value byte) bool {
	return value == ' ' || value == '\n' || value == '\r' || value == '\t'
}

func skipWhitespace(state *parserState) {
	for state.index < len(state.source) && isWhitespace(state.source[state.index]) {
		state.index += 1
	}
}

func isIdentifierStart(value byte) bool {
	return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') || value == '_'
}

func isIdentifierPart(value byte) bool {
	return isIdentifierStart(value) || (value >= '0' && value <= '9') || value == '.' || value == '-'
}

func isValidTemplateRef(value string) bool {
	if value == "" || !isIdentifierStart(value[0]) {
		return false
	}
	for index := 1; index < len(value); index += 1 {
		if !isIdentifierPart(value[index]) {
			return false
		}
	}
	return true
}

func (state *parserState) errorf(message string) error {
	return fmt.Errorf("cnos: %s at position %d", message, state.index+1)
}

func parseExpressionNode(state *parserState) (exprNode, error) {
	skipWhitespace(state)
	if state.index >= len(state.source) {
		return exprNode{}, state.errorf("Unexpected token")
	}

	current := state.source[state.index]
	switch {
	case current == '\'':
		return parseStringLiteral(state)
	case current >= '0' && current <= '9':
		return parseNumberLiteral(state)
	case isIdentifierStart(current):
		return parseIdentifierOrCall(state)
	default:
		return exprNode{}, state.errorf("Unexpected token")
	}
}

func parseStringLiteral(state *parserState) (exprNode, error) {
	state.index += 1
	var builder strings.Builder

	for state.index < len(state.source) {
		current := state.source[state.index]
		if current == '\\' {
			if state.index+1 >= len(state.source) {
				return exprNode{}, state.errorf("Unterminated escape sequence")
			}
			builder.WriteByte(state.source[state.index+1])
			state.index += 2
			continue
		}
		if current == '\'' {
			state.index += 1
			return exprNode{kind: "literal", value: builder.String()}, nil
		}
		builder.WriteByte(current)
		state.index += 1
	}

	return exprNode{}, state.errorf("Unterminated string literal")
}

func parseNumberLiteral(state *parserState) (exprNode, error) {
	start := state.index
	for state.index < len(state.source) && state.source[state.index] >= '0' && state.source[state.index] <= '9' {
		state.index += 1
	}
	if state.index < len(state.source) && state.source[state.index] == '.' {
		state.index += 1
		for state.index < len(state.source) && state.source[state.index] >= '0' && state.source[state.index] <= '9' {
			state.index += 1
		}
	}

	value, err := strconv.ParseFloat(state.source[start:state.index], 64)
	if err != nil {
		return exprNode{}, err
	}
	return exprNode{kind: "literal", value: value}, nil
}

func parseIdentifier(state *parserState) (string, error) {
	if state.index >= len(state.source) || !isIdentifierStart(state.source[state.index]) {
		return "", state.errorf("Expected identifier")
	}

	start := state.index
	state.index += 1
	for state.index < len(state.source) && isIdentifierPart(state.source[state.index]) {
		state.index += 1
	}
	return state.source[start:state.index], nil
}

func parseIdentifierOrCall(state *parserState) (exprNode, error) {
	identifier, err := parseIdentifier(state)
	if err != nil {
		return exprNode{}, err
	}

	skipWhitespace(state)
	if state.index < len(state.source) && state.source[state.index] == '(' {
		if _, ok := deriveBuiltins[identifier]; !ok {
			return exprNode{}, fmt.Errorf("cnos: unknown derive function: %s", identifier)
		}

		state.index += 1
		args, err := parseArguments(state)
		if err != nil {
			return exprNode{}, err
		}
		return exprNode{kind: "call", name: identifier, args: args}, nil
	}

	switch identifier {
	case "true":
		return exprNode{kind: "literal", value: true}, nil
	case "false":
		return exprNode{kind: "literal", value: false}, nil
	case "null":
		return exprNode{kind: "literal", value: nil}, nil
	default:
		return exprNode{kind: "ref", path: identifier}, nil
	}
}

func parseArguments(state *parserState) ([]exprNode, error) {
	args := []exprNode{}
	skipWhitespace(state)
	if state.index < len(state.source) && state.source[state.index] == ')' {
		state.index += 1
		return args, nil
	}

	for state.index < len(state.source) {
		node, err := parseExpressionNode(state)
		if err != nil {
			return nil, err
		}
		args = append(args, node)
		skipWhitespace(state)

		if state.index >= len(state.source) {
			break
		}
		switch state.source[state.index] {
		case ',':
			state.index += 1
			skipWhitespace(state)
		case ')':
			state.index += 1
			return args, nil
		default:
			return nil, state.errorf(`Expected "," or ")"`)
		}
	}

	return nil, state.errorf("Unterminated function call")
}
