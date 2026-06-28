package ai.kitsy.cnos.internal

internal object JsCompat {

    fun jsStringifyValue(value: Any?): String = when (value) {
        null -> "null"
        is Boolean -> value.toString()
        is Number -> jsNumberString(value)
        is List<*> -> "[${value.joinToString(",") { jsStringifyValue(it) }}]"
        is Map<*, *> -> "{${value.entries.joinToString(",") { (k, v) -> "\"$k\":${jsStringifyValue(v)}" }}}"
        else -> value.toString()
    }

    fun jsLogStringifyValue(value: Any?): String = when (value) {
        null -> ""
        is String -> value
        else -> jsStringifyValue(value)
    }

    fun jsNumberString(n: Number): String {
        val d = n.toDouble()
        return if (!d.isInfinite() && !d.isNaN() && d == kotlin.math.floor(d) && d in Long.MIN_VALUE.toDouble()..Long.MAX_VALUE.toDouble())
            d.toLong().toString()
        else d.toString()
    }

    fun isTruthy(value: Any?): Boolean = when (value) {
        null -> false
        is Boolean -> value
        is Number -> value.toDouble() != 0.0 && !value.toDouble().isNaN()
        is String -> value.isNotEmpty()
        is List<*> -> value.isNotEmpty()
        is Map<*, *> -> value.isNotEmpty()
        else -> true
    }

    fun jsStrictEqual(a: Any?, b: Any?): Boolean {
        if (a == null && b == null) return true
        if (a == null || b == null) return false
        if (a is Number && b is Number) return a.toDouble() == b.toDouble()
        if (a is Boolean && b is Boolean) return a == b
        if (a is String && b is String) return a == b
        return false
    }

    fun nodePlatform(): String {
        val os = System.getProperty("os.name", "").lowercase()
        return when {
            os.contains("win") -> "win32"
            os.contains("mac") -> "darwin"
            else -> "linux"
        }
    }

    fun nodeArch(): String = when (System.getProperty("os.arch", "").lowercase()) {
        "amd64", "x86_64" -> "x64"
        "aarch64", "arm64" -> "arm64"
        "x86" -> "ia32"
        else -> System.getProperty("os.arch", "").lowercase()
    }
}
