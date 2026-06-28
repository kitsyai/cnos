package ai.kitsy.cnos

import java.util.Optional
import java.util.concurrent.locks.ReentrantLock

object Cnos {
    private val lock = ReentrantLock()
    @Volatile private var instance: CnosRuntime? = null

    private fun runtime(): CnosRuntime {
        instance?.let { return it }
        lock.lock()
        try {
            instance?.let { return it }
            val rt = CnosRuntime.load(CnosOptions.defaults())
            instance = rt
            return rt
        } finally {
            lock.unlock()
        }
    }

    fun reset() {
        lock.lock()
        try { instance = null } finally { lock.unlock() }
    }

    fun init(options: CnosOptions) {
        lock.lock()
        try { instance = CnosRuntime.load(options) } finally { lock.unlock() }
    }

    fun read(key: String): Optional<Any> = runtime().read(key)
    fun require(key: String): Any = runtime().require(key)
    fun readOr(key: String, fallback: Any?): Any? = runtime().readOr(key, fallback)
    fun value(path: String): Optional<Any> = runtime().value(path)
    fun secret(path: String): Optional<Any> = runtime().secret(path)
    fun meta(path: String): Optional<Any> = runtime().meta(path)
    fun publicKey(path: String): Optional<Any> = runtime().publicKey(path)
    fun format(message: String): String = runtime().format(message)
    fun toPublicEnv(options: ToPublicEnvOptions = ToPublicEnvOptions()): Map<String, String> =
        runtime().toPublicEnv(options)
}
