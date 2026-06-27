using System;
using System.Collections.Generic;
using System.Text;
using Kitsy.Cnos;

namespace Kitsy.Cnos.Internal
{
    internal static class FormulaEvaluator
    {
        public delegate (object? Value, bool Found) RefResolver(string key);

        /// <summary>Evaluates a parsed formula. Throws CnosError on failure.</summary>
        public static object? Evaluate(string key, ParsedFormula formula, RefResolver resolveRef)
        {
            var (value, found) = EvaluateNode(formula.Ast, resolveRef);
            if (formula.Ast.Kind == "ref" && !found)
                throw new CnosError($"cnos: unable to resolve derived config key {key} because {formula.Ast.Path} is missing");
            return value;
        }

        private static (object? Value, bool Found) EvaluateNode(ExprNode node, RefResolver resolveRef)
        {
            return node.Kind switch
            {
                "literal" => (node.Value, true),
                "ref" => resolveRef(node.Path),
                "call" => EvaluateCall(node.Name, node.Args, resolveRef),
                _ => throw new CnosError($"cnos: unsupported derive AST node \"{node.Kind}\""),
            };
        }

        private static (object? Value, bool Found) EvaluateCall(string name, IReadOnlyList<ExprNode> args, RefResolver resolveRef)
        {
            var values = new object?[args.Count];
            var flags = new bool[args.Count];
            for (int i = 0; i < args.Count; i++)
            {
                var (v, f) = EvaluateNode(args[i], resolveRef);
                values[i] = v;
                flags[i] = f;
            }

            return name switch
            {
                "concat" => EvalConcat(values),
                "coalesce" => EvalCoalesce(values),
                "when" => EvalWhen(values),
                "exists" => EvalExists(values, flags),
                "eq" => (JsCompat.JsStrictEqual(At(values, 0), At(values, 1)), true),
                "ne" => (!JsCompat.JsStrictEqual(At(values, 0), At(values, 1)), true),
                _ => throw new CnosError($"cnos: unknown derive function: {name}"),
            };
        }

        private static (object? Value, bool Found) EvalConcat(object?[] values)
        {
            var sb = new StringBuilder();
            foreach (var v in values) sb.Append(JsCompat.JsStringifyValue(v));
            return (sb.ToString(), true);
        }

        private static (object? Value, bool Found) EvalCoalesce(object?[] values)
        {
            foreach (var v in values) if (v != null) return (v, true);
            return (null, true);
        }

        private static (object? Value, bool Found) EvalWhen(object?[] values)
        {
            object? whenTrue = values.Length > 1 ? values[1] : null;
            object? whenFalse = values.Length > 2 ? values[2] : null;
            return (JsCompat.IsTruthy(At(values, 0)) ? whenTrue : whenFalse, true);
        }

        private static (object? Value, bool Found) EvalExists(object?[] values, bool[] flags) =>
            (values.Length > 0 && flags[0] && values[0] != null, true);

        private static object? At(object?[] values, int index) =>
            index >= 0 && index < values.Length ? values[index] : null;
    }
}
