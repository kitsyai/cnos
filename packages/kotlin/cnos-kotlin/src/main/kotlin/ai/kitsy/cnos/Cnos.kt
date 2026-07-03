package ai.kitsy.cnos

import java.util.Optional
import java.util.concurrent.locks.ReentrantLock

/**
 * Singleton / module-level API for CNOS.
 * Mirrors the Go package-level functions in singleton.go.
 *
 * Call [ready] once at application startup, then use the object functions throughout.
 * Libraries should call these functions directly — no runtime instance needed.
 *
 * Example (library):
 *   val user = Cnos.require("value.email.brevo.user")
 *
 * Example (composition root / app):
 *   Cnos.ready()   // or Cnos.ready(CnosOptions(...))
 */
object Cnos {
    private val lock = ReentrantLock()
    @Volatile private var instance: CnosRuntime? = null

    init {
        // Attempt silent auto-bootstrap from env / .cnos-server.json at class load.
        // Failure is silently swallowed — the app calls ready() to initialize explicitly.
        try { bootstrapDefaultRuntime() } catch (_: Exception) {}
    }

    // ================================================================
    // Lifecycle
    // ================================================================

    /**
     * Initializes the default runtime, discovering the projection automatically.
     * If already initialized, registers any new vault providers from [options]
     * and returns (mirrors Go's warm-refresh behaviour).
     */
    fun ready(options: CnosOptions = CnosOptions.defaults()) {
        val current = instance
        if (current != null) {
            if (options.secretVaultProviders.isNotEmpty()) {
                current.registerSecretVaultProviders(*options.secretVaultProviders.toTypedArray())
            }
            return
        }
        val loaded = CnosRuntime.load(options)
        setDefaultRuntime(loaded)
    }

    /**
     * Sets the default runtime explicitly.
     * Use this in tests or when constructing the runtime manually.
     */
    fun setDefaultRuntime(runtime: CnosRuntime) {
        lock.lock()
        try { instance = runtime } finally { lock.unlock() }
    }

    /**
     * Returns the current default runtime.
     * @throws CnosError if the runtime has not been initialized.
     */
    fun defaultRuntime(): CnosRuntime =
        instance ?: throw CnosError(
            "cnos: runtime not initialized. Call Cnos.ready() or Cnos.setDefaultRuntime()"
        )

    /** Resets the default runtime. Use in tests to restore a clean state. */
    fun resetDefaultRuntime() {
        lock.lock()
        try { instance = null } finally { lock.unlock() }
    }

    @Deprecated("Use resetDefaultRuntime()", ReplaceWith("resetDefaultRuntime()"))
    fun reset() = resetDefaultRuntime()

    // ================================================================
    // Read APIs
    // ================================================================

    fun read(key: String): Optional<Any> = defaultRuntime().read(key)
    fun require(key: String): Any = defaultRuntime().require(key)
    fun readOr(key: String, fallback: Any?): Any? = defaultRuntime().readOr(key, fallback)
    fun value(path: String): Optional<Any> = defaultRuntime().value(path)
    fun secret(path: String): Optional<Any> = defaultRuntime().secret(path)
    fun meta(path: String): Optional<Any> = defaultRuntime().meta(path)
    fun publicKey(path: String): Optional<Any> = defaultRuntime().publicKey(path)
    fun json(path: String): Optional<Any> = defaultRuntime().json(path)
    fun pem(path: String): Optional<String> = defaultRuntime().pem(path)
    fun format(message: String): String = defaultRuntime().format(message)
    fun toObject(): Map<String, Any?> = defaultRuntime().toObject()
    fun toPublicEnv(options: ToPublicEnvOptions = ToPublicEnvOptions()): Map<String, String> =
        defaultRuntime().toPublicEnv(options)

    // ================================================================
    // Secrets
    // ================================================================

    fun refreshSecrets() = defaultRuntime().refreshSecrets()
    fun refreshSecret(path: String) = defaultRuntime().refreshSecret(path)

    // ================================================================
    // Registration
    // ================================================================

    fun registerRuntimeProvider(namespace: String, provider: (String) -> Any?) =
        defaultRuntime().registerRuntimeProvider(namespace, provider)

    fun registerSecretVaultProviders(vararg factories: SecretVaultProviderFactory) =
        defaultRuntime().registerSecretVaultProviders(*factories)

    // ================================================================
    // Private
    // ================================================================

    private fun bootstrapDefaultRuntime() {
        if (instance != null) return
        try {
            val rt = CnosRuntime.load(CnosOptions.defaults())
            lock.lock()
            try {
                if (instance == null) instance = rt
            } finally {
                lock.unlock()
            }
        } catch (_: CnosError) {
            // No projection found at class load — require explicit ready() call
        }
    }
}
