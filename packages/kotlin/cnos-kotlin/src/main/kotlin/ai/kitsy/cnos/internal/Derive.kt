package ai.kitsy.cnos.internal

import ai.kitsy.cnos.CnosError
import ai.kitsy.cnos.DerivedFormula

internal sealed class ExprNode {
    data class Literal(val value: Any?) : ExprNode()
    data class Ref(val key: String) : ExprNode()
    data class Call(val fn: String, val args: List<ExprNode>) : ExprNode()
    data class Template(val parts: List<ExprNode>) : ExprNode()
}

internal data class ParsedFormula(
    val raw: String,
    val ast: ExprNode,
    val isTemplate: Boolean,
    var deps: List<String>,
    var runtimeRefs: List<String>,
    var isRuntimeDependent: Boolean
)

internal object Derive {

    private val TEMPLATE_RE = Regex("""\$\{([^}]+)}""")

    fun parseDerivedFormula(formula: DerivedFormula): ParsedFormula {
        val expr = formula.expr.trim()
        val isTemplate = expr.contains("\${")
        val ast = if (isTemplate) parseTemplate(expr) else parseExpression(expr)
        val runtimeRefs = formula.runtimeRefs.toMutableList()
        val runtimeDependent = runtimeRefs.isNotEmpty()
        return ParsedFormula(
            raw = expr,
            ast = ast,
            isTemplate = isTemplate,
            deps = uniqueSorted(formula.deps.toMutableList()),
            runtimeRefs = uniqueSorted(runtimeRefs),
            isRuntimeDependent = runtimeDependent
        )
    }

    private fun parseTemplate(raw: String): ExprNode {
        val parts = mutableListOf<ExprNode>()
        var last = 0
        for (match in TEMPLATE_RE.findAll(raw)) {
            if (match.range.first > last) {
                parts.add(ExprNode.Literal(raw.substring(last, match.range.first)))
            }
            parts.add(ExprNode.Ref(match.groupValues[1].trim()))
            last = match.range.last + 1
        }
        if (last < raw.length) parts.add(ExprNode.Literal(raw.substring(last)))
        return if (parts.size == 1 && parts[0] is ExprNode.Ref) parts[0]
        else ExprNode.Template(parts)
    }

    fun parseExpression(raw: String): ExprNode {
        val s = raw.trim()
        // Single-quoted string literal
        if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
            return ExprNode.Literal(s.substring(1, s.length - 1))
        }
        // Boolean/null literals
        if (s == "true") return ExprNode.Literal(true)
        if (s == "false") return ExprNode.Literal(false)
        if (s == "null") return ExprNode.Literal(null)
        // Number
        s.toDoubleOrNull()?.let { return ExprNode.Literal(it) }
        // Function call
        val parenIdx = s.indexOf('(')
        if (parenIdx > 0 && s.endsWith(')')) {
            val fn = s.substring(0, parenIdx).trim()
            val argsStr = s.substring(parenIdx + 1, s.length - 1)
            val args = splitArgs(argsStr).map { parseExpression(it.trim()) }
            return ExprNode.Call(fn, args)
        }
        // Key reference
        return ExprNode.Ref(s)
    }

    private fun splitArgs(s: String): List<String> {
        val args = mutableListOf<String>()
        var depth = 0
        var inQuote = false
        var start = 0
        for (i in s.indices) {
            val c = s[i]
            when {
                c == '\'' && !inQuote -> inQuote = true
                c == '\'' && inQuote -> inQuote = false
                c == '(' && !inQuote -> depth++
                c == ')' && !inQuote -> depth--
                c == ',' && depth == 0 && !inQuote -> {
                    args.add(s.substring(start, i))
                    start = i + 1
                }
            }
        }
        val last = s.substring(start).trim()
        if (last.isNotEmpty()) args.add(last)
        return args
    }

    private fun collectRefs(node: ExprNode): Set<String> {
        return when (node) {
            is ExprNode.Literal -> emptySet()
            is ExprNode.Ref -> setOf(node.key)
            is ExprNode.Call -> node.args.flatMap { collectRefs(it) }.toSet()
            is ExprNode.Template -> node.parts.flatMap { collectRefs(it) }.toSet()
        }
    }

    fun evaluate(
        @Suppress("UNUSED_PARAMETER") key: String,
        formula: ParsedFormula,
        resolver: (String) -> Pair<Any?, Boolean>
    ): Any? = evalNode(formula.ast, resolver)

    private fun evalNode(node: ExprNode, resolver: (String) -> Pair<Any?, Boolean>): Any? = when (node) {
        is ExprNode.Literal -> node.value
        is ExprNode.Ref -> {
            val (value, found) = resolver(node.key)
            if (found) value else null
        }
        is ExprNode.Template -> {
            val sb = StringBuilder()
            for (part in node.parts) {
                when (part) {
                    is ExprNode.Literal -> sb.append(JsCompat.jsLogStringifyValue(part.value))
                    is ExprNode.Ref -> {
                        val (v, found) = resolver(part.key)
                        if (found) sb.append(JsCompat.jsLogStringifyValue(v))
                    }
                    else -> sb.append(JsCompat.jsLogStringifyValue(evalNode(part, resolver)))
                }
            }
            sb.toString()
        }
        is ExprNode.Call -> evalCall(node.fn, node.args, resolver)
    }

    private fun evalCall(fn: String, args: List<ExprNode>, resolver: (String) -> Pair<Any?, Boolean>): Any? {
        return when (fn) {
            "concat" -> args.joinToString("") { JsCompat.jsLogStringifyValue(evalNode(it, resolver)) }
            "coalesce" -> {
                for (arg in args) {
                    val v = evalNode(arg, resolver)
                    if (v != null) return v
                }
                null
            }
            "when" -> {
                if (args.size < 2) return null
                val cond = evalNode(args[0], resolver)
                if (JsCompat.isTruthy(cond)) evalNode(args[1], resolver)
                else if (args.size >= 3) evalNode(args[2], resolver) else null
            }
            "exists" -> {
                if (args.isEmpty()) return false
                val arg = args[0]
                if (arg is ExprNode.Ref) {
                    val (value, found) = resolver(arg.key)
                    found && value != null
                } else {
                    evalNode(arg, resolver) != null
                }
            }
            "eq" -> {
                if (args.size < 2) return false
                JsCompat.jsStrictEqual(evalNode(args[0], resolver), evalNode(args[1], resolver))
            }
            "ne" -> {
                if (args.size < 2) return true
                !JsCompat.jsStrictEqual(evalNode(args[0], resolver), evalNode(args[1], resolver))
            }
            else -> null
        }
    }

    fun uniqueSorted(list: List<String>): List<String> = list.distinct().sorted()

    internal fun allRefs(ast: ExprNode): List<String> = collectRefs(ast).toList()

    fun isDerivedValue(value: Any?): Boolean {
        if (value !is String) return false
        val s = value.trim()
        return s.startsWith("\${") || listOf("concat(", "coalesce(", "when(", "exists(", "eq(", "ne(")
            .any { s.startsWith(it) }
    }
}
