using System;
using System.Collections.Generic;
using System.Threading;

namespace Kitsy.Cnos
{
    /// <summary>
    /// Singleton / module-level API for CNOS.
    /// Mirrors the Go package-level delegating functions in <c>singleton.go</c>.
    ///
    /// <para>Call <see cref="Ready()"/> (or <see cref="Ready(CnosOptions)"/>) once at application startup,
    /// then use the static methods throughout your application.</para>
    /// </summary>
    public static class Cnos
    {
        private static volatile CnosRuntime? _defaultRuntime;
        private static readonly object _lock = new object();

        static Cnos()
        {
            try { BootstrapDefaultRuntime(); }
            catch { /* Silently ignore — application may call Ready() explicitly */ }
        }

        // ============================================================
        // Lifecycle
        // ============================================================

        /// <summary>Initializes the default runtime, discovering the projection automatically.</summary>
        public static void Ready() => Ready(CnosOptions.Defaults());

        /// <summary>Initializes the default runtime using the provided options.</summary>
        public static void Ready(CnosOptions? options)
        {
            options ??= CnosOptions.Defaults();

            CnosRuntime? current;
            lock (_lock) { current = _defaultRuntime; }

            if (current != null)
            {
                if (options.SecretVaultProviders?.Count > 0)
                    current.RegisterSecretVaultProviders(options.SecretVaultProviders.ToArray());
                current.RefreshSecrets();
                return;
            }

            var loaded = CnosRuntime.Load(options);
            SetDefaultRuntime(loaded);
        }

        /// <summary>Sets the default runtime explicitly.</summary>
        public static void SetDefaultRuntime(CnosRuntime runtime)
        {
            lock (_lock) { _defaultRuntime = runtime; }
        }

        /// <summary>Returns the current default runtime.</summary>
        /// <exception cref="CnosError">If the runtime has not been initialized.</exception>
        public static CnosRuntime DefaultRuntime()
        {
            var rt = _defaultRuntime;
            if (rt == null)
                throw new CnosError(
                    "cnos: runtime not initialized. Call Cnos.Ready() or load a runtime and set it as default");
            return rt;
        }

        /// <summary>Resets the default runtime (useful for testing).</summary>
        public static void ResetDefaultRuntime()
        {
            lock (_lock) { _defaultRuntime = null; }
        }

        // ============================================================
        // Read APIs (delegating)
        // ============================================================

        /// <summary>Reads any config key by its logical form.</summary>
        public static (object? Value, bool Found) Read(string key) => DefaultRuntime().Read(key);

        /// <summary>Reads a required key; throws if absent.</summary>
        public static object? Require(string key) => DefaultRuntime().Require(key);

        /// <summary>Reads a key, returning <paramref name="fallback"/> if absent.</summary>
        public static object? ReadOr(string key, object? fallback) => DefaultRuntime().ReadOr(key, fallback);

        /// <summary>Reads a <c>value.*</c> key.</summary>
        public static (object? Value, bool Found) Value(string path) => DefaultRuntime().Value(path);

        /// <summary>Reads a <c>secret.*</c> key.</summary>
        public static (object? Value, bool Found) Secret(string path) => DefaultRuntime().Secret(path);

        /// <summary>Reads a <c>meta.*</c> key.</summary>
        public static (object? Value, bool Found) Meta(string path) => DefaultRuntime().Meta(path);

        /// <summary>Reads a <c>public.*</c> key.</summary>
        public static (object? Value, bool Found) Public(string path) => DefaultRuntime().Public(path);

        /// <summary>Returns all resolved config as a flat dictionary.</summary>
        public static Dictionary<string, object?> ToObject() => DefaultRuntime().ToObject();

        /// <summary>Returns all resolved config for a namespace.</summary>
        public static Dictionary<string, object?> ToNamespace(string @namespace) =>
            DefaultRuntime().ToNamespace(@namespace);

        /// <summary>Returns env-mapped KEY=VALUE pairs.</summary>
        public static Dictionary<string, string> ToEnv(ToEnvOptions? options = null) =>
            DefaultRuntime().ToEnv(options);

        /// <summary>Returns public env KEY=VALUE pairs.</summary>
        public static Dictionary<string, string> ToPublicEnv(ToPublicEnvOptions? options = null) =>
            DefaultRuntime().ToPublicEnv(options);

        /// <summary>Inspects a config key.</summary>
        public static InspectResult Inspect(string key) => DefaultRuntime().Inspect(key);

        /// <summary>Formats a message string with <c>${key}</c> substitutions.</summary>
        public static string Format(string message) => DefaultRuntime().Format(message);

        /// <summary>Registers a runtime namespace value provider on the default runtime.</summary>
        public static void RegisterRuntimeProvider(string @namespace, Func<string, object?> provider) =>
            DefaultRuntime().RegisterRuntimeProvider(@namespace, provider);

        /// <summary>Registers vault provider factories on the default runtime.</summary>
        public static void RegisterSecretVaultProviders(params SecretVaultProviderFactory[] factories) =>
            DefaultRuntime().RegisterSecretVaultProviders(factories);

        /// <summary>Clears and re-warms all hydrated secrets on the default runtime.</summary>
        public static void RefreshSecrets() => DefaultRuntime().RefreshSecrets();

        /// <summary>Evicts and re-hydrates a single secret by sub-path or full logical key.</summary>
        public static void RefreshSecret(string path) => DefaultRuntime().RefreshSecret(path);

        // ============================================================
        // Private helpers
        // ============================================================

        private static void BootstrapDefaultRuntime()
        {
            if (_defaultRuntime != null) return;
            CnosRuntime rt;
            try { rt = CnosRuntime.Load(CnosOptions.Defaults()); }
            catch { return; }

            lock (_lock)
            {
                if (_defaultRuntime == null)
                    _defaultRuntime = rt;
            }
        }
    }
}
