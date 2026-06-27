using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Kitsy.Cnos.Internal;

namespace Kitsy.Cnos
{
    /// <summary>
    /// The CNOS C# runtime — consumes a pre-built server projection and provides typed read APIs.
    ///
    /// <para>Obtain an instance via <see cref="Load"/> or the static factory methods on <see cref="Cnos"/>.</para>
    /// </summary>
    public sealed class CnosRuntime
    {
        private const string ProjectionEnvVar = "__CNOS_PROJECTION__";
        private const string GraphEnvVar = "__CNOS_GRAPH__";
        private const string SecretPayloadEnvVar = "__CNOS_SECRET_PAYLOAD__";
        private const string SessionKeyEnvVar = "__CNOS_SESSION_KEY__";
        private const string ProjectionFileName = ".cnos-server.json";
        private const string CnosrcFileName = ".cnosrc.yml";

        private static readonly Regex _templatePattern = new Regex(@"\$\{([^}]+)\}", RegexOptions.Compiled);

        private readonly ServerProjection? _projection;
        private readonly BootstrappedManifest _manifest;
        private readonly string _profileSource;
        private readonly WorkspaceState _workspaceState;
        private readonly CnosEnvironment _env;
        private readonly string _secretHome;
        private readonly Dictionary<string, RuntimeEntry> _entries;
        private readonly Dictionary<string, string> _sources;
        private readonly HashSet<string> _runtimeNamespaces;
        private readonly Dictionary<string, Func<string, object?>> _runtimeProviders;
        private readonly Dictionary<string, object?>? _encryptedSecrets;
        private readonly Dictionary<string, object?> _hydratedSecrets;
        private readonly Dictionary<string, Dictionary<string, string>> _localVaultCache;
        private readonly Dictionary<string, string> _logicalKeyToVault;
        private readonly Dictionary<string, VaultDefinition> _vaults;
        private readonly Dictionary<string, SecretVaultProviderFactory> _secretFactories;

        private CnosRuntime(
            ServerProjection? projection,
            BootstrappedManifest manifest,
            string profileSource,
            WorkspaceState workspaceState,
            CnosEnvironment env,
            string secretHome,
            Dictionary<string, RuntimeEntry> entries,
            Dictionary<string, string> sources,
            HashSet<string> runtimeNamespaces,
            Dictionary<string, Func<string, object?>> runtimeProviders,
            Dictionary<string, object?>? encryptedSecrets,
            Dictionary<string, VaultDefinition> vaults,
            Dictionary<string, SecretVaultProviderFactory> secretFactories)
        {
            _projection = projection;
            _manifest = manifest;
            _profileSource = profileSource;
            _workspaceState = workspaceState;
            _env = env;
            _secretHome = secretHome;
            _entries = entries;
            _sources = sources;
            _runtimeNamespaces = runtimeNamespaces;
            _runtimeProviders = runtimeProviders;
            _encryptedSecrets = encryptedSecrets;
            _hydratedSecrets = new Dictionary<string, object?>(StringComparer.Ordinal);
            _localVaultCache = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
            _logicalKeyToVault = new Dictionary<string, string>(StringComparer.Ordinal);
            _vaults = vaults;
            _secretFactories = secretFactories;
        }

        // ============================================================
        // Static factory
        // ============================================================

        /// <summary>
        /// Loads a runtime using the standard discovery order:
        /// <list type="number">
        ///   <item>Explicit <see cref="CnosOptions.ProjectionData"/> or <see cref="CnosOptions.ProjectionPath"/></item>
        ///   <item><c>__CNOS_GRAPH__</c> env var</item>
        ///   <item><c>__CNOS_PROJECTION__</c> env var</item>
        ///   <item><c>.cnos-server.json</c> discovered from working directory</item>
        /// </list>
        /// </summary>
        public static CnosRuntime Load(CnosOptions? options = null)
        {
            options ??= CnosOptions.Defaults();
            var env = CnosEnvironment.Of(options.Environment);
            string secretHome = ResolveSecretHome(env, options.SecretHome);
            var factories = options.SecretVaultProviders;

            if (options.ProjectionData != null && options.ProjectionData.Length > 0)
                return NewRuntime(options.ProjectionData, env, secretHome, factories);

            if (!string.IsNullOrEmpty(options.ProjectionPath))
            {
                string path = ResolvePathFromWorkingDir(options.WorkingDir, options.ProjectionPath!);
                return NewRuntime(File.ReadAllBytes(path), env, secretHome, factories);
            }

            string? graphSerialized = env.Get(GraphEnvVar);
            if (!string.IsNullOrEmpty(graphSerialized))
                return NewRuntimeFromGraph(Encoding.UTF8.GetBytes(graphSerialized!), env, secretHome, factories);

            string? projSerialized = env.Get(ProjectionEnvVar);
            if (!string.IsNullOrEmpty(projSerialized))
                return NewRuntime(Encoding.UTF8.GetBytes(projSerialized!), env, secretHome, factories);

            string? projPath = FindProjectionPath(options.WorkingDir);
            if (projPath != null)
                return NewRuntime(File.ReadAllBytes(projPath), env, secretHome, factories);

            throw new CnosError(CnosError.ProjectionNotFound);
        }

        /// <summary>Loads from explicit projection bytes.</summary>
        public static CnosRuntime LoadProjection(byte[] data, CnosOptions? options = null) =>
            Load(new CnosOptions
            {
                ProjectionData = data,
                WorkingDir = options?.WorkingDir,
                Environment = options?.Environment,
                SecretHome = options?.SecretHome,
                SecretVaultProviders = options?.SecretVaultProviders ?? new List<SecretVaultProviderFactory>(),
            });

        // ============================================================
        // Public API
        // ============================================================

        /// <summary>Returns the underlying <see cref="ServerProjection"/> (valid when not graph-bootstrapped).</summary>
        public ServerProjection? GetProjection() => _projection;

        /// <summary>Reads any config key by its logical form (e.g. <c>value.server.port</c>).</summary>
        public (object? Value, bool Found) Read(string key)
        {
            return ReadInternal(key, new HashSet<string>(StringComparer.Ordinal));
        }

        /// <summary>Reads a required key; throws <see cref="CnosError"/> if absent.</summary>
        public object? Require(string key)
        {
            var (value, found) = Read(key);
            if (!found) throw new CnosError(CnosError.MissingKey + ": " + key);
            return value;
        }

        /// <summary>Reads a key, returning <paramref name="fallback"/> if absent.</summary>
        public object? ReadOr(string key, object? fallback)
        {
            var (value, found) = Read(key);
            return found ? value : fallback;
        }

        /// <summary>Reads a <c>value.*</c> key by sub-path.</summary>
        public (object? Value, bool Found) Value(string path) => Read(ToLogicalKey("value", path));

        /// <summary>Reads a <c>secret.*</c> key by sub-path.</summary>
        public (object? Value, bool Found) Secret(string path) => Read(ToLogicalKey("secret", path));

        /// <summary>Reads a <c>meta.*</c> key by sub-path.</summary>
        public (object? Value, bool Found) Meta(string path) => Read(ToLogicalKey("meta", path));

        /// <summary>Reads a <c>public.*</c> key by sub-path.</summary>
        public (object? Value, bool Found) Public(string path) => Read(ToLogicalKey("public", path));

        /// <summary>Returns all resolved config values as a flat dictionary keyed by full logical key.</summary>
        public Dictionary<string, object?> ToObject() => ToNamespaceObject("");

        /// <summary>Returns all resolved config values for a specific namespace.</summary>
        public Dictionary<string, object?> ToNamespace(string @namespace) => ToNamespaceObject(@namespace ?? "");

        /// <summary>Returns env-mapping entries as KEY=VALUE pairs.</summary>
        public Dictionary<string, string> ToEnv(ToEnvOptions? options = null)
        {
            options ??= new ToEnvOptions();
            var output = new Dictionary<string, string>(StringComparer.Ordinal);
            var envVars = _manifest.EnvMappingExplicit.Keys.ToList();
            envVars.Sort(StringComparer.Ordinal);

            foreach (string envVar in envVars)
            {
                string logicalKey = _manifest.EnvMappingExplicit[envVar];
                if (!_entries.TryGetValue(logicalKey, out var entry) || entry == null) continue;

                var def = _manifest.GetNamespaceDef(entry.Namespace);
                if (def.Kind != BootstrappedManifest.KindData) continue;
                if (entry.Namespace == "secret") { if (!options.IncludeSecrets) continue; }
                else if (!def.Shareable || def.Sensitive) continue;

                var (value, found) = ReadInternal(logicalKey, new HashSet<string>(StringComparer.Ordinal));
                if (!found || value == null) continue;
                output[envVar] = JsCompat.JsStringifyValue(value);
            }
            return output;
        }

        /// <summary>Returns public env entries, with optional framework prefix applied.</summary>
        public Dictionary<string, string> ToPublicEnv(ToPublicEnvOptions? options = null)
        {
            options ??= new ToPublicEnvOptions();
            string prefix = ResolvePublicPrefix(options);
            var output = new Dictionary<string, string>(StringComparer.Ordinal);

            var keys = _entries.Keys.Where(k =>
            {
                var e = _entries[k];
                return e != null && e.Namespace == "public";
            }).OrderBy(k => k, StringComparer.Ordinal).ToList();

            foreach (string key in keys)
            {
                string sourceKey = ResolveProjectedSourceKey(key);
                if (_entries.TryGetValue(sourceKey, out var source) &&
                    source?.Formula != null && source.Formula.RuntimeDependent)
                {
                    var (rv, rf) = ReadInternal(key, new HashSet<string>(StringComparer.Ordinal));
                    if (!rf || rv == null)
                        throw new CnosError(
                            $"cnos: cannot build public output for {key} because it depends on runtime-only values");
                }

                var (value, found) = ReadInternal(key, new HashSet<string>(StringComparer.Ordinal));
                if (!found || value == null) continue;

                string subPath = key.StartsWith("public.", StringComparison.Ordinal) ? key.Substring(7) : key;
                string baseEnvVar = FallbackPublicEnvVar(subPath);
                string envVar = !string.IsNullOrEmpty(prefix) && !baseEnvVar.StartsWith(prefix, StringComparison.Ordinal)
                    ? prefix + baseEnvVar
                    : baseEnvVar;
                output[envVar] = JsCompat.JsStringifyValue(value);
            }
            return output;
        }

        /// <summary>Inspects a config key, returning detailed provenance and derivation info.</summary>
        public InspectResult Inspect(string key)
        {
            if (!_entries.TryGetValue(key, out var entry) || entry == null)
                throw new CnosError(CnosError.MissingKey + ": " + key);

            var (value, _) = ReadInternal(key, new HashSet<string>(StringComparer.Ordinal));

            string wsId = !string.IsNullOrEmpty(_workspaceState.Id) ? _workspaceState.Id : ProfileWorkspace("workspace");
            string wsSource = !string.IsNullOrEmpty(_workspaceState.Source) ? _workspaceState.Source : "implicit";
            var wsChain = _workspaceState.Chain.Count > 0 ? (IReadOnlyList<string>)_workspaceState.Chain : InspectWorkspaceChain();

            var ws = new InspectResult.InspectWorkspace(wsId, wsSource, wsChain);

            var winner = entry.Winner;
            var inspectWinner = new InspectResult.InspectWinner(
                FirstNonEmpty(winner?.SourceId, _sources.GetValueOrDefault(key)),
                FirstNonEmpty(winner?.PluginId, "cnos"),
                FirstNonEmpty(winner?.WorkspaceId, ProfileWorkspace("workspace")),
                winner?.Origin?.Copy());

            var overrides = entry.Overridden.Select(p => new InspectResult.InspectOverride(
                p.SourceId, FirstNonEmpty(p.PluginId, p.SourceId), p.WorkspaceId, p.Value, p.Origin?.Copy()
            )).ToList();

            InspectResult.InspectDerived? derived = null;
            if (entry.Formula != null)
                derived = BuildInspectDerived(key, entry);

            return new InspectResult(
                key, value, entry.Namespace,
                ProfileWorkspace("profile"),
                FirstNonEmpty(_profileSource, "manifest-default"),
                ws, inspectWinner, overrides, derived);
        }

        /// <summary>Formats a message string by substituting <c>${key}</c> patterns.</summary>
        public string Format(string message)
        {
            CnosError? error = null;
            string result = _templatePattern.Replace(message, m =>
            {
                if (error != null) return m.Value;
                string k = m.Groups[1].Value.Trim();
                if (string.IsNullOrEmpty(k)) return m.Value;
                try
                {
                    var (value, found) = ReadInternal(k, new HashSet<string>(StringComparer.Ordinal));
                    return found ? JsCompat.JsLogStringifyValue(value) : m.Value;
                }
                catch (CnosError ex) { error = ex; return m.Value; }
            });
            if (error != null) throw error;
            return result;
        }

        /// <summary>Registers a runtime namespace value provider.</summary>
        public void RegisterRuntimeProvider(string @namespace, Func<string, object?> provider)
        {
            if (@namespace == "process")
                throw new CnosError("cnos: cannot override built-in runtime namespace \"process\"");
            if (!_runtimeNamespaces.Contains(@namespace))
                throw new CnosError($"cnos: cannot register runtime provider for undeclared namespace \"{@namespace}\"");
            _runtimeProviders[@namespace] = provider;
        }

        /// <summary>Registers additional vault provider factories on this runtime.</summary>
        public void RegisterSecretVaultProviders(params SecretVaultProviderFactory[] factories)
        {
            foreach (var factory in factories)
                if (factory != null && !string.IsNullOrEmpty(factory.ProviderName))
                    _secretFactories[factory.ProviderName] = factory;
        }

        /// <summary>Clears all hydrated secret caches and re-warms every secret in the projection.</summary>
        public void RefreshSecrets()
        {
            var savedHydrated = new Dictionary<string, object?>(_hydratedSecrets, StringComparer.Ordinal);
            var savedLocal = _localVaultCache.ToDictionary(
                kv => kv.Key,
                kv => new Dictionary<string, string>(kv.Value, StringComparer.Ordinal),
                StringComparer.Ordinal);

            _hydratedSecrets.Clear();
            _localVaultCache.Clear();
            try { WarmSecrets(); }
            catch (CnosError)
            {
                _hydratedSecrets.Clear();
                foreach (var kv in savedHydrated) _hydratedSecrets[kv.Key] = kv.Value;
                _localVaultCache.Clear();
                foreach (var kv in savedLocal) _localVaultCache[kv.Key] = kv.Value;
                throw;
            }
        }

        /// <summary>Evicts and re-hydrates a single secret by its sub-path or full logical key.</summary>
        public void RefreshSecret(string path)
        {
            string key = ToLogicalKey("secret", path);
            if (!_entries.TryGetValue(key, out var entry) || entry?.SecretRef == null) return;

            bool hadValue = _hydratedSecrets.ContainsKey(key);
            object? savedValue = _hydratedSecrets.GetValueOrDefault(key);
            string? vaultId = _logicalKeyToVault.GetValueOrDefault(key);
            Dictionary<string, string>? savedVaultCache = null;
            if (vaultId != null && _localVaultCache.TryGetValue(vaultId, out var vc))
                savedVaultCache = new Dictionary<string, string>(vc, StringComparer.Ordinal);

            _hydratedSecrets.Remove(key);
            if (vaultId != null) _localVaultCache.Remove(vaultId);

            try { ReadSecret(key, entry.SecretRef); }
            catch (CnosError)
            {
                if (hadValue) _hydratedSecrets[key] = savedValue;
                if (vaultId != null)
                {
                    if (savedVaultCache != null) _localVaultCache[vaultId] = savedVaultCache;
                    else _localVaultCache.Remove(vaultId);
                }
                throw;
            }
        }

        // ============================================================
        // Internal read
        // ============================================================

        internal (object? Value, bool Found) ReadInternal(string key, HashSet<string> stack)
        {
            if (!_entries.TryGetValue(key, out var entry) || entry == null)
            {
                int dot = key.IndexOf('.');
                if (dot > 0)
                {
                    string ns = key.Substring(0, dot);
                    string rest = key.Substring(dot + 1);
                    if (_runtimeProviders.TryGetValue(ns, out var provider))
                        return (provider(rest), true);
                }
                return (null, false);
            }

            if (!string.IsNullOrEmpty(entry.AliasTo))
                return ReadInternal(entry.AliasTo!, stack);

            if (entry.SecretRef != null)
                return ReadSecret(key, entry.SecretRef);

            if (entry.Formula != null)
            {
                if (stack.Contains(key))
                    throw new CnosError(
                        $"cnos: unable to resolve derived config key {key} because of a recursive dependency on {key}");

                if (!entry.Formula.RuntimeDependent && entry.Formula.IsCached)
                    return (entry.Formula.Cache, true);

                var next = new HashSet<string>(stack, StringComparer.Ordinal) { key };
                object? value = FormulaEvaluator.Evaluate(key, entry.Formula, ref2 => ReadInternal(ref2, next));
                if (!entry.Formula.RuntimeDependent)
                {
                    entry.Formula.Cache = value;
                    entry.Formula.IsCached = true;
                }
                return (value, true);
            }

            return (UnboxJsonElement(entry.Value), true);
        }

        // ============================================================
        // Secret hydration
        // ============================================================

        private (object? Value, bool Found) ReadSecret(string key, SecretReference @ref)
        {
            ValidateSecretRefVaultProvider(key, @ref);

            if (_encryptedSecrets != null && _encryptedSecrets.TryGetValue(key, out var enc))
                return (enc, true);
            if (_hydratedSecrets.TryGetValue(key, out var cached))
                return (cached, true);

            var definitions = SecretVaultDefinitions(@ref);
            CnosError? lastError = null;
            foreach (var def in definitions)
            {
                try
                {
                    (object? v, bool found) = ReadSecretWithDefinition(key, @ref, def);
                    if (found && v != null)
                    {
                        _hydratedSecrets[key] = v;
                        return (v, true);
                    }
                }
                catch (CnosError ex) { lastError = ex; }
            }

            if (lastError != null) throw lastError;
            _hydratedSecrets[key] = null;
            return (null, true);
        }

        private (object? Value, bool Found) ReadSecretWithDefinition(string key, SecretReference @ref, VaultDefinition def)
        {
            switch (def.Provider)
            {
                case "environment":
                case "github-secrets":
                    return (ReadEnvironmentSecretWithDefinition(@ref, def), true);
                case "local":
                {
                    var secrets = LocalVaultSecrets(@ref.Vault);
                    return (secrets.TryGetValue(@ref.Ref, out string? v) ? v : null, true);
                }
                default:
                {
                    if (!_secretFactories.ContainsKey(def.Provider))
                        throw new CnosError($"cnos: unsupported vault provider: {def.Provider}");
                    var refsByKey = RefsForVaultCandidate(@ref.Vault, def);
                    HydrateCustomVault(@ref.Vault, def, refsByKey);
                    return (_hydratedSecrets.GetValueOrDefault(key), true);
                }
            }
        }

        private List<VaultDefinition> SecretVaultDefinitions(SecretReference @ref)
        {
            var def = SecretVaultDefinition(@ref);
            var list = new List<VaultDefinition> { def };
            list.AddRange(def.Fallback);
            return list;
        }

        private VaultDefinition SecretVaultDefinition(SecretReference @ref)
        {
            if (_vaults.TryGetValue(@ref.Vault, out var def))
            {
                if (string.IsNullOrEmpty(def.Provider))
                    def = def.WithProvider(@ref.Provider);
                return def;
            }
            string provider = !string.IsNullOrEmpty(@ref.Provider) ? @ref.Provider : "local";
            return new VaultDefinition
            {
                Provider = provider,
                Auth = new VaultAuth { Method = VaultResolver.DefaultVaultMethod(provider) },
                Mapping = new Dictionary<string, string>(),
                Fallback = new List<VaultDefinition>(),
            };
        }

        private void ValidateSecretRefVaultProvider(string key, SecretReference @ref)
        {
            if (string.IsNullOrEmpty(@ref.Vault) || string.IsNullOrEmpty(@ref.Provider)) return;
            if (!_vaults.TryGetValue(@ref.Vault, out var def) ||
                string.IsNullOrEmpty(def.Provider) || def.Provider == @ref.Provider) return;
            throw new CnosError(
                $"cnos: secret ref \"{key}\" declares provider \"{@ref.Provider}\" " +
                $"but vault \"{@ref.Vault}\" uses provider \"{def.Provider}\"");
        }

        private Dictionary<string, string> RefsForVaultCandidate(string vaultId, VaultDefinition definition)
        {
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (string key in _entries.Keys.OrderBy(k => k, StringComparer.Ordinal))
            {
                var entry = _entries[key];
                if (entry?.SecretRef == null || entry.SecretRef.Vault != vaultId) continue;
                if (_hydratedSecrets.ContainsKey(key)) continue;
                foreach (var candidate in SecretVaultDefinitions(entry.SecretRef))
                    if (candidate.Provider == definition.Provider)
                    {
                        result[key] = entry.SecretRef.Ref;
                        break;
                    }
            }
            return result;
        }

        private void HydrateCustomVault(string vaultId, VaultDefinition definition,
            Dictionary<string, string> refsByKey)
        {
            if (!_secretFactories.TryGetValue(definition.Provider, out var factory))
                throw new CnosError($"cnos: unsupported vault provider: {definition.Provider}");

            var seen = new HashSet<string>(StringComparer.Ordinal);
            var refs = new List<string>();
            foreach (string r in refsByKey.Values) if (seen.Add(r)) refs.Add(r);
            refs.Sort(StringComparer.Ordinal);

            var provider = factory.Create(vaultId, definition);
            if (provider == null)
                throw new CnosError(
                    $"cnos: create vault provider \"{definition.Provider}\" for vault \"{vaultId}\" returned null");

            var auth = VaultResolver.ResolveVaultAuth(vaultId, definition, _env);
            provider.Authenticate(auth);

            var values = provider.BatchGet(refs);
            foreach (var kv in refsByKey)
            {
                if (_hydratedSecrets.ContainsKey(kv.Key)) continue;
                if (values.TryGetValue(kv.Value, out var v) && v != null)
                    _hydratedSecrets[kv.Key] = v;
            }
        }

        private object? ReadEnvironmentSecretWithDefinition(SecretReference @ref, VaultDefinition definition)
        {
            string? v = _env.Get(@ref.Ref);
            if (v != null) return v;
            if (!string.IsNullOrEmpty(@ref.EnvVar)) { v = _env.Get(@ref.EnvVar!); if (v != null) return v; }
            if (definition.Mapping != null)
            {
                foreach (var kv in definition.Mapping)
                    if (kv.Value == @ref.Ref) { v = _env.Get(kv.Key); if (v != null) return v; break; }
            }
            return null;
        }

        private Dictionary<string, string> LocalVaultSecrets(string vaultId)
        {
            if (_localVaultCache.TryGetValue(vaultId, out var cached)) return cached;

            _vaults.TryGetValue(vaultId, out var definition);
            string metaPath = Path.Combine(_secretHome, "vaults", vaultId, "meta.yml");
            if (!File.Exists(metaPath))
                throw new CnosError($"cnos: missing CNOS vault metadata for \"{vaultId}\"");

            var meta = LocalVault.ParseMetadata(File.ReadAllBytes(metaPath));
            byte[] key = VaultResolver.ResolveLocalVaultKey(_secretHome, vaultId, meta, definition, _env);
            var secrets = LocalVault.ReadVaultSecrets(_secretHome, vaultId, key);
            _localVaultCache[vaultId] = secrets;
            return secrets;
        }

        private void WarmSecrets()
        {
            foreach (string key in _entries.Keys.OrderBy(k => k, StringComparer.Ordinal))
            {
                if (_entries.TryGetValue(key, out var entry) && entry?.SecretRef != null)
                    ReadSecret(key, entry.SecretRef);
            }
        }

        // ============================================================
        // toObject / toNamespace
        // ============================================================

        private Dictionary<string, object?> ToNamespaceObject(string @namespace)
        {
            var output = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (string key in _entries.Keys.OrderBy(k => k, StringComparer.Ordinal))
            {
                var entry = _entries[key];
                if (entry == null) continue;
                if (!string.IsNullOrEmpty(@namespace) && entry.Namespace != @namespace) continue;

                var (value, found) = ReadInternal(key, new HashSet<string>(StringComparer.Ordinal));
                if (!found) continue;

                string targetPath = string.IsNullOrEmpty(@namespace) ? key : key.Substring(@namespace.Length + 1);
                SetNestedValue(output, targetPath.Split('.'), value);
            }
            return output;
        }

        // ============================================================
        // Runtime construction
        // ============================================================

        private static CnosRuntime NewRuntime(byte[] source, CnosEnvironment env, string secretHome,
            List<SecretVaultProviderFactory> factories)
        {
            var projection = ServerProjection.Parse(source);
            var encryptedSecrets = DecryptSecretPayloadFromEnv(env);
            var manifest = BootstrappedManifestFromProjection(projection);

            var rt = new CnosRuntime(
                projection, manifest, "manifest-default",
                NewImplicitWorkspaceState(projection.Workspace),
                env, secretHome,
                new Dictionary<string, RuntimeEntry>(StringComparer.Ordinal),
                new Dictionary<string, string>(StringComparer.Ordinal),
                new HashSet<string>(StringComparer.Ordinal),
                new Dictionary<string, Func<string, object?>>(StringComparer.Ordinal),
                encryptedSecrets,
                projection.Vaults ?? new Dictionary<string, VaultDefinition>(),
                BuildFactoryMap(factories));

            rt.PopulateEntries();
            rt.InitializeRuntimeProviders(projection.RuntimeNamespaces ?? new List<string>());
            rt.PrepareDerivedEntries();
            return rt;
        }

        private static CnosRuntime NewRuntimeFromGraph(byte[] source, CnosEnvironment env, string secretHome,
            List<SecretVaultProviderFactory> factories)
        {
            var graph = RuntimeGraph.Parse(source);
            var encryptedSecrets = DecryptSecretPayloadFromEnv(env);
            var manifest = new BootstrappedManifest(
                new Dictionary<string, BootstrappedManifest.NamespaceDef>(BootstrappedManifest.DefaultNamespaces),
                new Dictionary<string, string>(BootstrappedManifest.DefaultFrameworks),
                new Dictionary<string, string>(),
                new Dictionary<string, VaultDefinition>());

            var ws = new WorkspaceState(
                graph.Workspace.WorkspaceId,
                graph.Workspace.WorkspaceSource,
                new List<string>(graph.Workspace.WorkspaceChain));

            var entries = new Dictionary<string, RuntimeEntry>(StringComparer.Ordinal);
            var sources = new Dictionary<string, string>(StringComparer.Ordinal);

            var rt = new CnosRuntime(
                null, manifest, graph.ProfileSource, ws,
                env, secretHome,
                entries, sources,
                new HashSet<string>(StringComparer.Ordinal),
                new Dictionary<string, Func<string, object?>>(StringComparer.Ordinal),
                encryptedSecrets,
                new Dictionary<string, VaultDefinition>(),
                BuildFactoryMap(factories));

            foreach (var resolved in graph.Entries)
            {
                var entry = RuntimeEntryFromGraph(resolved);
                rt._entries[resolved.Key] = entry;
                rt._sources[resolved.Key] = resolved.Winner.SourceId;
                if (entry.SecretRef != null && !string.IsNullOrEmpty(entry.SecretRef.Vault))
                    rt._logicalKeyToVault[resolved.Key] = entry.SecretRef.Vault;
            }

            rt.InitializeRuntimeProviders(SortedRuntimeNamespaces(graph));
            rt.PrepareDerivedEntries();
            return rt;
        }

        private void PopulateEntries()
        {
            var explicitNamespaces = new HashSet<string>(StringComparer.Ordinal)
                { "config", "flags", "process" };
            if (_projection!.Meta.Namespaces != null)
                foreach (string ns in _projection.Meta.Namespaces) explicitNamespaces.Add(ns);

            var serverProv = new RuntimeProvenance("server-projection", "cnos", _projection.Workspace);

            foreach (var kv in _projection.Values)
            {
                string logicalKey = ProjectionLogicalKey(kv.Key, explicitNamespaces);
                _entries[logicalKey] = new RuntimeEntry
                {
                    Key = logicalKey,
                    Namespace = NamespaceForKey(logicalKey),
                    Value = kv.Value,
                    Winner = serverProv,
                };
                _sources[logicalKey] = "server-projection";
            }

            foreach (var kv in _projection.Derived)
            {
                string logicalKey = ProjectionLogicalKey(kv.Key, explicitNamespaces);
                ParsedFormula parsed;
                try { parsed = FormulaParser.ParseDerivedFormula(kv.Value); }
                catch (CnosError ex)
                {
                    throw new CnosError($"cnos: parse derived formula for {logicalKey}: {ex.Message}", ex);
                }
                _entries[logicalKey] = new RuntimeEntry
                {
                    Key = logicalKey,
                    Namespace = NamespaceForKey(logicalKey),
                    Formula = parsed,
                    Winner = serverProv,
                };
                _sources[logicalKey] = "server-projection";
            }

            foreach (var kv in _projection.SecretRefs)
            {
                string logicalKey = ToLogicalKey("secret", kv.Key);
                var r = kv.Value;
                if (string.IsNullOrEmpty(r.Vault)) r = r.WithVault("default");
                _entries[logicalKey] = new RuntimeEntry
                {
                    Key = logicalKey,
                    Namespace = "secret",
                    SecretRef = r,
                    Winner = serverProv,
                };
                _sources[logicalKey] = "server-projection";
                _logicalKeyToVault[logicalKey] = r.Vault;
            }

            foreach (string key in _projection.PublicKeys)
            {
                string sourceKey = key;
                if (!_entries.ContainsKey(sourceKey)) sourceKey = ToLogicalKey("value", key);
                if (!_entries.ContainsKey(sourceKey)) continue;

                string publicKey = ToLogicalKey("public", key);
                _entries[publicKey] = new RuntimeEntry
                {
                    Key = publicKey,
                    Namespace = "public",
                    AliasTo = sourceKey,
                    PromotedFrom = sourceKey,
                    Winner = serverProv,
                };
                _sources[publicKey] = "server-projection";
            }

            _entries["meta.profile"] = new RuntimeEntry { Key = "meta.profile", Namespace = "meta", Value = _projection.Profile, Winner = serverProv };
            _entries["meta.workspace"] = new RuntimeEntry { Key = "meta.workspace", Namespace = "meta", Value = _projection.Workspace, Winner = serverProv };
            _entries["meta.cnos_version"] = new RuntimeEntry { Key = "meta.cnos_version", Namespace = "meta", Value = _projection.Meta.CnosVersion, Winner = serverProv };
            _sources["meta.profile"] = _sources["meta.workspace"] = _sources["meta.cnos_version"] = "server-projection";
        }

        private void InitializeRuntimeProviders(IEnumerable<string> namespaces)
        {
            foreach (string ns in namespaces) _runtimeNamespaces.Add(ns);
            if (_runtimeNamespaces.Contains("process"))
                _runtimeProviders["process"] = BuildProcessProvider();
        }

        private Func<string, object?> BuildProcessProvider()
        {
            return path =>
            {
                if (path.StartsWith("env.", StringComparison.Ordinal))
                    return _env.Get(path.Substring(4));
                return path switch
                {
                    "cwd" => Directory.GetCurrentDirectory(),
                    "platform" => JsCompat.NodePlatform(),
                    "arch" => JsCompat.NodeArch(),
                    "pid" => (long)System.Diagnostics.Process.GetCurrentProcess().Id,
                    _ => null,
                };
            };
        }

        private void PrepareDerivedEntries()
        {
            var keys = _entries.Keys.Where(k => _entries[k]?.Formula != null)
                .OrderBy(k => k, StringComparer.Ordinal).ToList();

            var resolved = new HashSet<string>(StringComparer.Ordinal);
            var visiting = new HashSet<string>(StringComparer.Ordinal);
            foreach (string key in keys)
                VisitDerived(key, resolved, visiting);
        }

        private void VisitDerived(string key, HashSet<string> resolved, HashSet<string> visiting)
        {
            if (resolved.Contains(key)) return;
            if (visiting.Contains(key))
                throw new CnosError(
                    $"cnos: unable to resolve derived config key {key} because of a recursive dependency on {key}");

            if (!_entries.TryGetValue(key, out var entry) || entry?.Formula == null)
            {
                resolved.Add(key);
                return;
            }

            visiting.Add(key);
            var formula = entry.Formula;
            var runtimeRefs = new List<string>(formula.RuntimeRefs);
            bool runtimeDependent = formula.RuntimeDependent;

            foreach (string @ref in formula.Refs)
            {
                string ns = NamespaceForKey(@ref);
                if (string.IsNullOrEmpty(ns)) continue;

                if (_runtimeNamespaces.Contains(ns))
                {
                    runtimeDependent = true;
                    if (!runtimeRefs.Contains(@ref)) runtimeRefs.Add(@ref);
                    continue;
                }

                if (_entries.TryGetValue(@ref, out var dep) && dep?.Formula != null)
                {
                    VisitDerived(@ref, resolved, visiting);
                    if (dep.Formula.RuntimeDependent) runtimeDependent = true;
                }
            }

            formula.RuntimeRefs = FormulaParser.UniqueSorted(runtimeRefs);
            formula.RuntimeDependent = runtimeDependent;
            formula.Deps = FilterFormulaDeps(formula.Refs, _runtimeNamespaces);
            visiting.Remove(key);
            resolved.Add(key);
        }

        // ============================================================
        // Bootstrap helpers
        // ============================================================

        private static BootstrappedManifest BootstrappedManifestFromProjection(ServerProjection projection)
        {
            var namespaces = new Dictionary<string, BootstrappedManifest.NamespaceDef>(
                BootstrappedManifest.DefaultNamespaces, StringComparer.Ordinal);
            if (projection.Meta.Namespaces != null)
            {
                foreach (string ns in projection.Meta.Namespaces)
                    if (!namespaces.ContainsKey(ns))
                        namespaces[ns] = new BootstrappedManifest.NamespaceDef(
                            BootstrappedManifest.KindData, false, false, true, null);
            }
            return new BootstrappedManifest(
                namespaces,
                new Dictionary<string, string>(BootstrappedManifest.DefaultFrameworks, StringComparer.Ordinal),
                new Dictionary<string, string>(),
                projection.Vaults ?? new Dictionary<string, VaultDefinition>());
        }

        private static RuntimeEntry RuntimeEntryFromGraph(RuntimeGraph.ResolvedEntry resolved)
        {
            var winner = resolved.Winner;
            ConfigOrigin? origin = winner.Origin;
            var prov = new RuntimeProvenance(
                winner.SourceId, winner.PluginId, winner.WorkspaceId,
                winner.Value.HasValue ? UnboxJsonElementStatic(winner.Value.Value) : null,
                origin);

            var overridden = resolved.Overridden.Select(o => new RuntimeProvenance(
                o.SourceId, o.PluginId, o.WorkspaceId,
                o.Value.HasValue ? UnboxJsonElementStatic(o.Value.Value) : null,
                o.Origin)).ToList();

            string? promotedFrom = null;
            if (winner.Metadata?.TryGetValue("promotedFrom", out var pmeta) == true &&
                pmeta.ValueKind == JsonValueKind.String)
                promotedFrom = pmeta.GetString();

            var entry = new RuntimeEntry
            {
                Key = resolved.Key,
                Namespace = resolved.Namespace,
                PromotedFrom = promotedFrom,
                Winner = prov,
                Overridden = overridden,
            };

            if (resolved.Namespace == "secret" && resolved.Value.HasValue)
            {
                var v = resolved.Value.Value;
                if (IsSecretReferenceValue(v))
                {
                    var @ref = ToSecretReference(v);
                    if (string.IsNullOrEmpty(@ref.Vault)) @ref = @ref.WithVault("default");
                    entry.SecretRef = @ref;
                    return entry;
                }
            }

            if (resolved.Value.HasValue && FormulaParser.IsDerivedValue(resolved.Value.Value))
            {
                entry.Formula = FormulaParser.ParseRawDerivedValue(resolved.Value.Value);
                return entry;
            }

            entry.Value = resolved.Value.HasValue ? UnboxJsonElementStatic(resolved.Value.Value) : null;
            return entry;
        }

        private static bool IsSecretReferenceValue(JsonElement el)
        {
            if (el.ValueKind != JsonValueKind.Object) return false;
            bool hasRef = false;
            foreach (var prop in el.EnumerateObject())
            {
                if (prop.Name == "ref" && prop.Value.ValueKind == JsonValueKind.String &&
                    !string.IsNullOrWhiteSpace(prop.Value.GetString()))
                    hasRef = true;
                else if (prop.Name != "provider" && prop.Name != "vault") return false;
            }
            return hasRef;
        }

        private static SecretReference ToSecretReference(JsonElement el)
        {
            string provider = el.TryGetProperty("provider", out var p) ? p.GetString() ?? "" : "";
            string @ref = el.TryGetProperty("ref", out var r) ? r.GetString() ?? "" : "";
            string vault = el.TryGetProperty("vault", out var v) ? v.GetString() ?? "" : "";
            if (string.IsNullOrWhiteSpace(@ref)) throw new CnosError("cnos: invalid secret reference");
            return new SecretReference { Provider = provider.Trim(), Ref = @ref.Trim(), Vault = vault.Trim() };
        }

        private static List<string> SortedRuntimeNamespaces(RuntimeGraph graph)
        {
            var configNs = new HashSet<string>(StringComparer.Ordinal) { "value", "secret", "meta", "public" };
            foreach (var e in graph.Entries) configNs.Add(e.Namespace);

            var runtimeNs = new SortedSet<string>(StringComparer.Ordinal) { "process" };
            foreach (var e in graph.Entries)
            {
                if (!e.Value.HasValue || !FormulaParser.IsDerivedValue(e.Value.Value)) continue;
                try
                {
                    var pf = FormulaParser.ParseRawDerivedValue(e.Value.Value);
                    foreach (string r in pf.Refs)
                    {
                        string ns = NamespaceForKey(r);
                        if (!string.IsNullOrEmpty(ns) && !configNs.Contains(ns)) runtimeNs.Add(ns);
                    }
                }
                catch { }
            }
            return new List<string>(runtimeNs);
        }

        private static Dictionary<string, object?>? DecryptSecretPayloadFromEnv(CnosEnvironment env)
        {
            string? payload = env.Get(SecretPayloadEnvVar);
            if (string.IsNullOrEmpty(payload)) return null;
            string? sessionKey = env.Get(SessionKeyEnvVar);
            if (string.IsNullOrEmpty(sessionKey)) return null;

            byte[] plaintext = LocalVault.DecryptSessionPayload(sessionKey!, payload!);
            try
            {
                using var doc = JsonDocument.Parse(plaintext);
                var result = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var prop in doc.RootElement.EnumerateObject())
                    result[prop.Name] = UnboxJsonElementStatic(prop.Value);
                return result;
            }
            catch (Exception ex)
            {
                throw new CnosError("cnos: decode encrypted secret payload: " + ex.Message, ex);
            }
        }

        // ============================================================
        // Inspect helpers
        // ============================================================

        private InspectResult.InspectDerived BuildInspectDerived(string key, RuntimeEntry entry)
        {
            var formula = entry.Formula!;
            var deps = formula.Refs.Select(r =>
            {
                var (value, found) = ReadInternal(r, new HashSet<string>(StringComparer.Ordinal));
                string? runtimeNs = _runtimeNamespaces.Contains(NamespaceForKey(r)) ? NamespaceForKey(r) : null;
                return new InspectResult.InspectDependency(r, found ? value : null, runtimeNs);
            }).ToList();

            var runtimeNsList = formula.RuntimeRefs
                .Select(r => NamespaceForKey(r))
                .Where(ns => !string.IsNullOrEmpty(ns))
                .Distinct().OrderBy(ns => ns, StringComparer.Ordinal).ToList();

            string? warning = formula.RuntimeDependent ? "Cannot be promoted to browser/public." : null;

            return new InspectResult.InspectDerived(
                formula.IsTemplate ? "template" : "expression",
                formula.Raw, deps, formula.RuntimeDependent, runtimeNsList, warning);
        }

        private string ProfileWorkspace(string kind)
        {
            string metaKey = kind == "workspace" ? "meta.workspace" : "meta.profile";
            try
            {
                var (v, found) = ReadInternal(metaKey, new HashSet<string>(StringComparer.Ordinal));
                if (found && v is string s) return s;
            }
            catch { }
            return "";
        }

        private IReadOnlyList<string> InspectWorkspaceChain()
        {
            if (_workspaceState.Chain.Count > 0) return _workspaceState.Chain;
            string ws = ProfileWorkspace("workspace");
            return string.IsNullOrEmpty(ws) ? Array.Empty<string>() : new[] { ws };
        }

        // ============================================================
        // String/key helpers
        // ============================================================

        internal static string NamespaceForKey(string key)
        {
            int dot = key?.IndexOf('.') ?? -1;
            return dot > 0 ? key!.Substring(0, dot) : "";
        }

        internal static string ToLogicalKey(string @namespace, string valuePath)
        {
            if (string.IsNullOrWhiteSpace(valuePath)) return @namespace + ".";
            string trimmed = valuePath.Trim();
            if (trimmed.StartsWith(@namespace + ".", StringComparison.Ordinal)) return trimmed;
            var sb = new StringBuilder(@namespace).Append('.');
            bool first = true;
            foreach (string part in trimmed.Split('.'))
            {
                string p = part.Trim();
                if (!string.IsNullOrEmpty(p))
                {
                    if (!first) sb.Append('.');
                    sb.Append(p);
                    first = false;
                }
            }
            return sb.ToString();
        }

        private static string ProjectionLogicalKey(string raw, HashSet<string> explicitNamespaces)
        {
            if (raw.StartsWith("value.", StringComparison.Ordinal) ||
                raw.StartsWith("public.", StringComparison.Ordinal)) return raw;
            int dot = raw.IndexOf('.');
            string first = dot >= 0 ? raw.Substring(0, dot) : raw;
            if (explicitNamespaces.Contains(first)) return raw;
            return ToLogicalKey("value", raw);
        }

        private string ResolvePublicPrefix(ToPublicEnvOptions options)
        {
            if (!string.IsNullOrEmpty(options.Prefix)) return options.Prefix!;
            if (string.IsNullOrEmpty(options.Framework)) return "";
            if (_manifest.Frameworks.TryGetValue(options.Framework!, out string? prefix)) return prefix;
            throw new CnosError($"cnos: unknown public framework prefix: {options.Framework}");
        }

        private string ResolveProjectedSourceKey(string key)
        {
            if (_entries.TryGetValue(key, out var entry))
            {
                if (!string.IsNullOrEmpty(entry?.AliasTo)) return entry!.AliasTo!;
                if (!string.IsNullOrEmpty(entry?.PromotedFrom)) return entry!.PromotedFrom!;
            }
            if (key.StartsWith("public.", StringComparison.Ordinal))
            {
                string fallback = "value." + key.Substring(7);
                if (_entries.ContainsKey(fallback)) return fallback;
            }
            return key;
        }

        private static string FallbackPublicEnvVar(string valuePath)
        {
            var sb = new StringBuilder();
            bool lastUnderscore = false;
            foreach (char c in valuePath)
            {
                if (c >= 'a' && c <= 'z') { sb.Append((char)(c - 32)); lastUnderscore = false; }
                else if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) { sb.Append(c); lastUnderscore = false; }
                else if (!lastUnderscore) { sb.Append('_'); lastUnderscore = true; }
            }
            string result = sb.ToString().Trim('_');
            return result;
        }

        private static List<string> FilterFormulaDeps(List<string> refs, HashSet<string> runtimeNamespaces)
        {
            var deps = refs
                .Where(r => { string ns = NamespaceForKey(r); return !string.IsNullOrEmpty(ns) && !runtimeNamespaces.Contains(ns); })
                .ToList();
            return FormulaParser.UniqueSorted(deps);
        }

        private static void SetNestedValue(Dictionary<string, object?> target, string[] segments, object? value)
        {
            if (segments.Length == 0 || string.IsNullOrEmpty(segments[0])) return;
            if (segments.Length == 1) { target[segments[0]] = value; return; }

            if (!target.TryGetValue(segments[0], out var existing) || existing is not Dictionary<string, object?> child)
            {
                child = new Dictionary<string, object?>(StringComparer.Ordinal);
                target[segments[0]] = child;
            }
            SetNestedValue(child, segments[1..], value);
        }

        private static Dictionary<string, SecretVaultProviderFactory> BuildFactoryMap(
            List<SecretVaultProviderFactory> factories)
        {
            var map = new Dictionary<string, SecretVaultProviderFactory>(StringComparer.Ordinal);
            if (factories == null) return map;
            foreach (var f in factories)
                if (f != null && !string.IsNullOrEmpty(f.ProviderName))
                    map[f.ProviderName] = f;
            return map;
        }

        // ============================================================
        // Discovery helpers
        // ============================================================

        private static string? FindProjectionPath(string? workingDir)
        {
            string cwd = !string.IsNullOrEmpty(workingDir)
                ? Path.GetFullPath(workingDir)
                : Directory.GetCurrentDirectory();

            string direct = Path.Combine(cwd, ProjectionFileName);
            if (File.Exists(direct)) return direct;

            string? current = cwd;
            for (int depth = 0; depth <= 3 && current != null; depth++)
            {
                if (File.Exists(Path.Combine(current, CnosrcFileName)))
                {
                    string proj = Path.Combine(current, ProjectionFileName);
                    if (File.Exists(proj)) return proj;
                }
                current = Path.GetDirectoryName(current);
            }
            return null;
        }

        private static string ResolveSecretHome(CnosEnvironment env, string? @override)
        {
            if (!string.IsNullOrWhiteSpace(@override))
                return ExpandHome(@override!);
            string? envHome = env.Get("CNOS_SECRET_HOME");
            if (!string.IsNullOrWhiteSpace(envHome))
                return ExpandHome(envHome!.Trim());
            return ExpandHome("~/.cnos/secrets");
        }

        private static string ResolvePathFromWorkingDir(string? workingDir, string target)
        {
            if (Path.IsPathRooted(target)) return target;
            string base_ = !string.IsNullOrEmpty(workingDir)
                ? Path.GetFullPath(workingDir)
                : Directory.GetCurrentDirectory();
            return Path.Combine(base_, target);
        }

        private static string ExpandHome(string path)
        {
            string home = System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile);
            if (path == "~") return home;
            if (path.StartsWith("~/", StringComparison.Ordinal)) return home + path.Substring(1);
            if (path.StartsWith("~\\", StringComparison.Ordinal)) return home + path.Substring(1);
            return Path.GetFullPath(path);
        }

        private static WorkspaceState NewImplicitWorkspaceState(string workspace)
        {
            if (string.IsNullOrWhiteSpace(workspace))
                return new WorkspaceState(null, "implicit", new List<string>());
            return new WorkspaceState(workspace, "implicit", new List<string> { workspace });
        }

        private static object? UnboxJsonElement(object? value)
        {
            if (value is JsonElement el) return UnboxJsonElementStatic(el);
            return value;
        }

        private static object? UnboxJsonElementStatic(JsonElement el) => el.ValueKind switch
        {
            JsonValueKind.Null => null,
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.String => el.GetString(),
            JsonValueKind.Number => el.TryGetInt64(out long l) ? (object)l : el.GetDouble(),
            JsonValueKind.Object or JsonValueKind.Array => el,
            _ => null,
        };

        private static string FirstNonEmpty(params string?[] values)
        {
            foreach (string? v in values)
                if (!string.IsNullOrWhiteSpace(v)) return v!.Trim();
            return "";
        }

        // ============================================================
        // Inner types
        // ============================================================

        private sealed class WorkspaceState
        {
            public string? Id { get; }
            public string Source { get; }
            public List<string> Chain { get; }

            public WorkspaceState(string? id, string source, List<string> chain)
            {
                Id = id; Source = source; Chain = chain;
            }
        }
    }
}
