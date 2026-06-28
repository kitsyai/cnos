package ai.kitsy.cnos

class CnosError(message: String, cause: Throwable? = null) : Exception(message, cause) {
    val isProjectionNotFound: Boolean
        get() = message?.startsWith("cnos: no projection") == true

    companion object {
        const val PROJECTION_NOT_FOUND = "cnos: no projection found"
        const val MISSING_KEY = "cnos: missing required config key"
    }
}
