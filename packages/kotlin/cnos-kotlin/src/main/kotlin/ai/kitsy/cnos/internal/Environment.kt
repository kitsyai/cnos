package ai.kitsy.cnos.internal

internal class Environment(private val overrides: Map<String, String>?) {
    fun get(name: String): String? = overrides?.get(name) ?: System.getenv(name)

    companion object {
        fun of(overrides: Map<String, String>?) = Environment(overrides)
    }
}
