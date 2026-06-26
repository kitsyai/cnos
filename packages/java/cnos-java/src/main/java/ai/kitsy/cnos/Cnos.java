package ai.kitsy.cnos;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Singleton / module-level API for CNOS.
 * Mirrors the Go package-level delegating functions in {@code singleton.go}.
 *
 * <p>Call {@link #ready()} (or {@link #ready(CnosOptions)}) once at application startup,
 * then use the static methods throughout your application.
 */
public final class Cnos {

    private static final ReentrantLock LOCK = new ReentrantLock();
    private static volatile CnosRuntime defaultRuntime;

    private Cnos() {}

    // ================================================================
    // Lifecycle
    // ================================================================

    /**
     * Initializes the default runtime, discovering the projection automatically.
     * If a default runtime is already set, registers any new vault providers from options
     * and then refreshes all hydrated secrets (mirrors Go's warm-refresh behaviour).
     *
     * @throws CnosError if no projection is found or loading fails
     */
    public static void ready() throws CnosError {
        ready(CnosOptions.defaults());
    }

    /**
     * Initializes the default runtime using the provided options.
     * If a default runtime is already set, registers any new vault providers from options
     * and then refreshes all hydrated secrets (mirrors Go's warm-refresh behaviour).
     *
     * @throws CnosError if no projection is found or loading fails
     */
    public static void ready(CnosOptions options) throws CnosError {
        if (options == null) options = CnosOptions.defaults();

        LOCK.lock();
        CnosRuntime runtime;
        try {
            runtime = defaultRuntime;
        } finally {
            LOCK.unlock();
        }

        if (runtime != null) {
            if (!options.getSecretVaultProviders().isEmpty()) {
                runtime.registerSecretVaultProviders(
                        options.getSecretVaultProviders().toArray(new SecretVaultProviderFactory[0]));
            }
            runtime.refreshSecrets();
            return;
        }

        CnosRuntime loaded = CnosRuntime.load(options);
        setDefaultRuntime(loaded);
    }

    /**
     * Sets the default runtime explicitly.
     */
    public static void setDefaultRuntime(CnosRuntime runtime) {
        LOCK.lock();
        try {
            defaultRuntime = runtime;
        } finally {
            LOCK.unlock();
        }
    }

    /**
     * Returns the current default runtime.
     *
     * @throws CnosError if the runtime has not been initialized
     */
    public static CnosRuntime defaultRuntime() throws CnosError {
        CnosRuntime runtime = defaultRuntime;
        if (runtime == null) {
            throw new CnosError("cnos: runtime not initialized. Call Cnos.ready() or load a runtime and set it as default");
        }
        return runtime;
    }

    /** Resets the default runtime (useful for testing). */
    public static void resetDefaultRuntime() {
        LOCK.lock();
        try {
            defaultRuntime = null;
        } finally {
            LOCK.unlock();
        }
    }

    // Auto-bootstrap attempt at class load time (mirrors Go's init())
    static {
        try {
            bootstrapDefaultRuntime();
        } catch (Exception ignored) {
            // Silently ignore — the application may call ready() explicitly
        }
    }

    private static void bootstrapDefaultRuntime() {
        if (defaultRuntime != null) return;
        try {
            CnosRuntime runtime = CnosRuntime.load(CnosOptions.defaults());
            LOCK.lock();
            try {
                if (defaultRuntime == null) {
                    defaultRuntime = runtime;
                }
            } finally {
                LOCK.unlock();
            }
        } catch (CnosError ignored) {
            // No projection found at startup — require explicit ready() call
        }
    }

    // ================================================================
    // Read APIs (delegating)
    // ================================================================

    /** Reads any config key by its logical form. */
    public static Optional<Object> read(String key) throws CnosError {
        return defaultRuntime().read(key);
    }

    /** Reads a required key; throws if absent. */
    public static Object require(String key) throws CnosError {
        return defaultRuntime().require(key);
    }

    /** Reads a key, returning {@code fallback} if absent. */
    public static Object readOr(String key, Object fallback) throws CnosError {
        return defaultRuntime().readOr(key, fallback);
    }

    /** Reads a {@code value.*} key. */
    public static Optional<Object> value(String path) throws CnosError {
        return defaultRuntime().value(path);
    }

    /** Reads a {@code secret.*} key. */
    public static Optional<Object> secret(String path) throws CnosError {
        return defaultRuntime().secret(path);
    }

    /** Reads a {@code meta.*} key. */
    public static Optional<Object> meta(String path) throws CnosError {
        return defaultRuntime().meta(path);
    }

    /** Reads a {@code public.*} key. */
    public static Optional<Object> publicKey(String path) throws CnosError {
        return defaultRuntime().publicKey(path);
    }

    /** Returns all resolved config as a nested map. */
    public static Map<String, Object> toObject() throws CnosError {
        return defaultRuntime().toObject();
    }

    /** Returns all resolved config for a namespace. */
    public static Map<String, Object> toNamespace(String namespace) throws CnosError {
        return defaultRuntime().toNamespace(namespace);
    }

    /** Returns env-mapped KEY=VALUE pairs. */
    public static Map<String, String> toEnv() throws CnosError {
        return defaultRuntime().toEnv(new ToEnvOptions());
    }

    /** Returns env-mapped KEY=VALUE pairs with options. */
    public static Map<String, String> toEnv(ToEnvOptions options) throws CnosError {
        return defaultRuntime().toEnv(options);
    }

    /** Returns public env KEY=VALUE pairs. */
    public static Map<String, String> toPublicEnv() throws CnosError {
        return defaultRuntime().toPublicEnv(new ToPublicEnvOptions());
    }

    /** Returns public env KEY=VALUE pairs with options. */
    public static Map<String, String> toPublicEnv(ToPublicEnvOptions options) throws CnosError {
        return defaultRuntime().toPublicEnv(options);
    }

    /** Inspects a config key. */
    public static InspectResult inspect(String key) throws CnosError {
        return defaultRuntime().inspect(key);
    }

    /** Formats a message string with {@code ${key}} substitutions. */
    public static String format(String message) throws CnosError {
        return defaultRuntime().format(message);
    }

    /** Registers a runtime namespace value provider on the default runtime. */
    public static void registerRuntimeProvider(String namespace,
            java.util.function.Function<String, Object> provider) throws CnosError {
        defaultRuntime().registerRuntimeProvider(namespace, provider);
    }

    /** Registers vault provider factories on the default runtime. */
    public static void registerSecretVaultProviders(SecretVaultProviderFactory... factories) throws CnosError {
        defaultRuntime().registerSecretVaultProviders(factories);
    }

    /** Clears and re-warms all hydrated secrets on the default runtime. */
    public static void refreshSecrets() throws CnosError {
        defaultRuntime().refreshSecrets();
    }

    /** Evicts and re-hydrates a single secret by sub-path or full logical key. */
    public static void refreshSecret(String path) throws CnosError {
        defaultRuntime().refreshSecret(path);
    }
}
