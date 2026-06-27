using System;
using System.Collections.Generic;
using System.Text.Json;
using Kitsy.Cnos;

namespace Kitsy.Cnos.Internal
{
    internal sealed class ParsedFormula
    {
        public string Raw { get; set; } = "";
        public List<string> Refs { get; set; } = new();
        public List<string> Deps { get; set; } = new();
        public List<string> RuntimeRefs { get; set; } = new();
        public bool RuntimeDependent { get; set; }
        public bool IsTemplate { get; set; }
        public ExprNode Ast { get; set; } = ExprNode.Literal(null);

        public bool IsCached { get; set; }
        public object? Cache { get; set; }
    }

    internal sealed class ExprNode
    {
        public string Kind { get; }   // literal, ref, call
        public object? Value { get; }
        public string Path { get; }
        public string Name { get; }
        public IReadOnlyList<ExprNode> Args { get; }

        private ExprNode(string kind, object? value, string path, string name, IReadOnlyList<ExprNode> args)
        {
            Kind = kind; Value = value; Path = path; Name = name; Args = args;
        }

        public static ExprNode Literal(object? value) =>
            new ExprNode("literal", value, "", "", Array.Empty<ExprNode>());

        public static ExprNode Ref(string path) =>
            new ExprNode("ref", null, path, "", Array.Empty<ExprNode>());

        public static ExprNode Call(string name, IReadOnlyList<ExprNode> args) =>
            new ExprNode("call", null, "", name, args);
    }

    internal static class FormulaParser
    {
        private static readonly HashSet<string> _builtins = new HashSet<string>(StringComparer.Ordinal)
        {
            "concat", "coalesce", "when", "exists", "eq", "ne",
        };

        public static ParsedFormula ParseDerivedFormula(DerivedFormula formula)
        {
            ExprNode ast = ParseDerivedSource(formula.Expr);
            var refs = new List<string>(formula.Deps);
            foreach (var r in formula.RuntimeRefs)
                if (!refs.Contains(r)) refs.Add(r);

            return new ParsedFormula
            {
                Raw = formula.Expr,
                Refs = UniqueSorted(refs),
                Deps = new List<string>(formula.Deps),
                RuntimeRefs = new List<string>(formula.RuntimeRefs),
                RuntimeDependent = formula.RuntimeRefs.Count > 0,
                IsTemplate = formula.Expr.Contains("${"),
                Ast = ast,
            };
        }

        public static ParsedFormula ParseRawDerivedValue(object? value)
        {
            string source = DeriveSourceFromValue(value);
            ExprNode ast = ParseDerivedSource(source);
            var refs = ExtractRefs(ast, new List<string>());

            return new ParsedFormula
            {
                Raw = source,
                Refs = UniqueSorted(refs),
                Deps = UniqueSorted(refs),
                RuntimeRefs = new List<string>(),
                IsTemplate = source.Contains("${"),
                Ast = ast,
            };
        }

        public static bool IsDerivedValue(object? value)
        {
            if (value is not JsonElement el) return false;
            if (el.ValueKind != JsonValueKind.Object) return false;
            return el.TryGetProperty("$derive", out _);
        }

        private static string DeriveSourceFromValue(object? value)
        {
            if (value is not JsonElement el || el.ValueKind != JsonValueKind.Object)
                throw new CnosError("cnos: derived value requires either a template string or { expr } object");

            if (!el.TryGetProperty("$derive", out var derive))
                throw new CnosError("cnos: derived value requires either a template string or { expr } object");

            if (derive.ValueKind == JsonValueKind.String)
                return derive.GetString() ?? "";

            if (derive.ValueKind == JsonValueKind.Object && derive.TryGetProperty("expr", out var expr))
            {
                string s = expr.GetString() ?? "";
                if (!string.IsNullOrWhiteSpace(s)) return s;
            }

            throw new CnosError("cnos: derived value requires either a template string or { expr } object");
        }

        private static ExprNode ParseDerivedSource(string source)
        {
            if (source.Contains("${"))
                return ParseTemplate(source);

            var state = new ParserState(source);
            ExprNode node = ParseExpressionNode(state);
            SkipWhitespace(state);
            if (state.Index != source.Length)
                throw state.Errorf("Unexpected trailing input");
            return node;
        }

        private static ExprNode ParseTemplate(string source)
        {
            var parts = new List<ExprNode>();
            int cursor = 0;

            while (cursor < source.Length)
            {
                int start = source.IndexOf("${", cursor, StringComparison.Ordinal);
                if (start < 0)
                {
                    if (cursor < source.Length)
                        parts.Add(ExprNode.Literal(source.Substring(cursor)));
                    break;
                }

                if (start > cursor)
                    parts.Add(ExprNode.Literal(source.Substring(cursor, start - cursor)));

                int end = source.IndexOf('}', start + 2);
                if (end < 0)
                    throw new CnosError($"cnos: invalid derivation template: unclosed ${{...}} at position {start + 1}");

                string refStr = source.Substring(start + 2, end - start - 2).Trim();
                if (string.IsNullOrEmpty(refStr))
                    throw new CnosError($"cnos: invalid derivation template: empty reference at position {start + 1}");
                if (!IsValidTemplateRef(refStr))
                    throw new CnosError($"cnos: invalid derivation template reference \"{refStr}\"");

                parts.Add(ExprNode.Ref(refStr));
                cursor = end + 1;
            }

            if (parts.Count == 0) return ExprNode.Literal("");
            if (parts.Count == 1) return parts[0];
            return ExprNode.Call("concat", parts);
        }

        private static ExprNode ParseExpressionNode(ParserState state)
        {
            SkipWhitespace(state);
            if (state.Index >= state.Source.Length)
                throw state.Errorf("Unexpected token");

            char c = state.Source[state.Index];
            if (c == '\'') return ParseStringLiteral(state);
            if (c >= '0' && c <= '9') return ParseNumberLiteral(state);
            if (IsIdentifierStart(c)) return ParseIdentifierOrCall(state);
            throw state.Errorf("Unexpected token");
        }

        private static ExprNode ParseStringLiteral(ParserState state)
        {
            state.Index++;
            var sb = new System.Text.StringBuilder();
            while (state.Index < state.Source.Length)
            {
                char c = state.Source[state.Index];
                if (c == '\\')
                {
                    if (state.Index + 1 >= state.Source.Length)
                        throw state.Errorf("Unterminated escape sequence");
                    sb.Append(state.Source[state.Index + 1]);
                    state.Index += 2;
                    continue;
                }
                if (c == '\'') { state.Index++; return ExprNode.Literal(sb.ToString()); }
                sb.Append(c);
                state.Index++;
            }
            throw state.Errorf("Unterminated string literal");
        }

        private static ExprNode ParseNumberLiteral(ParserState state)
        {
            int start = state.Index;
            while (state.Index < state.Source.Length && state.Source[state.Index] >= '0' && state.Source[state.Index] <= '9')
                state.Index++;
            if (state.Index < state.Source.Length && state.Source[state.Index] == '.')
            {
                state.Index++;
                while (state.Index < state.Source.Length && state.Source[state.Index] >= '0' && state.Source[state.Index] <= '9')
                    state.Index++;
            }
            string raw = state.Source.Substring(start, state.Index - start);
            if (!double.TryParse(raw, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out double d))
                throw new CnosError($"cnos: invalid number literal: {raw}");
            return ExprNode.Literal(d);
        }

        private static ExprNode ParseIdentifierOrCall(ParserState state)
        {
            string identifier = ParseIdentifier(state);
            SkipWhitespace(state);
            if (state.Index < state.Source.Length && state.Source[state.Index] == '(')
            {
                if (!_builtins.Contains(identifier))
                    throw new CnosError($"cnos: unknown derive function: {identifier}");
                state.Index++;
                var args = ParseArguments(state);
                return ExprNode.Call(identifier, args);
            }

            return identifier switch
            {
                "true" => ExprNode.Literal(true),
                "false" => ExprNode.Literal(false),
                "null" => ExprNode.Literal(null),
                _ => ExprNode.Ref(identifier),
            };
        }

        private static string ParseIdentifier(ParserState state)
        {
            if (state.Index >= state.Source.Length || !IsIdentifierStart(state.Source[state.Index]))
                throw state.Errorf("Expected identifier");
            int start = state.Index++;
            while (state.Index < state.Source.Length && IsIdentifierPart(state.Source[state.Index]))
                state.Index++;
            return state.Source.Substring(start, state.Index - start);
        }

        private static List<ExprNode> ParseArguments(ParserState state)
        {
            var args = new List<ExprNode>();
            SkipWhitespace(state);
            if (state.Index < state.Source.Length && state.Source[state.Index] == ')')
            {
                state.Index++;
                return args;
            }
            while (state.Index < state.Source.Length)
            {
                args.Add(ParseExpressionNode(state));
                SkipWhitespace(state);
                if (state.Index >= state.Source.Length) break;
                if (state.Source[state.Index] == ',') { state.Index++; SkipWhitespace(state); }
                else if (state.Source[state.Index] == ')') { state.Index++; return args; }
                else throw state.Errorf("Expected \",\" or \")\"");
            }
            throw state.Errorf("Unterminated function call");
        }

        private static void SkipWhitespace(ParserState state)
        {
            while (state.Index < state.Source.Length && IsWhitespace(state.Source[state.Index]))
                state.Index++;
        }

        private static bool IsWhitespace(char c) => c == ' ' || c == '\n' || c == '\r' || c == '\t';
        private static bool IsIdentifierStart(char c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
        private static bool IsIdentifierPart(char c) => IsIdentifierStart(c) || (c >= '0' && c <= '9') || c == '.' || c == '-';

        private static bool IsValidTemplateRef(string value)
        {
            if (string.IsNullOrEmpty(value) || !IsIdentifierStart(value[0])) return false;
            for (int i = 1; i < value.Length; i++)
                if (!IsIdentifierPart(value[i])) return false;
            return true;
        }

        private static List<string> ExtractRefs(ExprNode node, List<string> refs)
        {
            if (node.Kind == "ref") { refs.Add(node.Path); return refs; }
            if (node.Kind == "call") foreach (var arg in node.Args) ExtractRefs(arg, refs);
            return refs;
        }

        public static List<string> UniqueSorted(List<string> items)
        {
            var set = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var s in items) set.Add(s);
            return new List<string>(set);
        }

        private sealed class ParserState
        {
            public string Source { get; }
            public int Index { get; set; }

            public ParserState(string source) { Source = source; Index = 0; }

            public CnosError Errorf(string message) =>
                new CnosError($"cnos: {message} at position {Index + 1}");
        }
    }
}
