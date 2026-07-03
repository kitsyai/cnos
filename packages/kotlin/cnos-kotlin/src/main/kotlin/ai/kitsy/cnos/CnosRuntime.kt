package ai.kitsy.cnos

import ai.kitsy.cnos.internal.*
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import java.io.File
import java.util.Optional
import java.util.concurrent.ConcurrentHashMap

class CnosRuntime private constructor(
    private val projection: ServerProjection?,
    private val manifest: BootstrappedManifest,
    private val env: Environment,
    private val secretHome: String,
    private val entries: MutableMap<String, RuntimeEntry>,
    private val runtimeNamespaces: MutableSet<String>,
    private val encryptedSecrets: Map<String, Any?>?,
    private val parsedArgs: Map<String, String> = emptyMap(),
    private val fileOverrides: Map<String, Any?> = emptyMap()
) {
    private val runtimeProviders = ConcurrentHashMap<String, (String) -> Any?>()
    private val hydratedSecrets = ConcurrentHashMap<String, Any>()
    private val localVaultCache = ConcurrentHashMap<String, Map<String, String>>()
    private val logicalKeyToVault = ConcurrentHashMap<String, String>()
    private val vaults: Map<String, VaultDefinition> = manifest.vaults
    private val secretFactories = ConcurrentHashMap<String, SecretVaultProviderFactory>()
    internal var graphOverrides: Map<String, OverrideSpec> = emptyMap()

    fun getProjection(): ServerProjection? = projection

    // ================================================================
    // Public API
    // ================================================================

    fun read(key: String): Optional<Any> {
        val effectiveOverrides = projection?.overrides?.takeIf { it.isNotEmpty() } ?: graphOverrides
        if (key.startsWith("value.") && effectiveOverrides.isNotEmpty()) {
            val stripped = key.removePrefix("value.")
            val spec = effectiveOverrides[stripped]
            if (spec != null) {
                // File override participates as the "cnos" source.
                val (cnosVal, cnosFound) = fileOrCnos(key)
                return applyOverride(spec, cnosVal, cnosFound, parsedArgs, env, key)
            }
        }
        // No OverrideSpec: file then CNOS.
        if (fileOverrides.containsKey(key)) return Optional.ofNullable(fileOverrides[key])
        val (value, found) = readInternal(key, mutableSetOf())
        return if (found) Optional.ofNullable(value) else Optional.empty()
    }

    private fun fileOrCnos(key: String): Pair<Any?, Boolean> {
        if (fileOverrides.containsKey(key)) return Pair(fileOverrides[key], true)
        return readInternal(key, mutableSetOf())
    }

    fun require(key: String): Any {
        val (value, found) = readInternal(key, mutableSetOf())
        if (!found) throw CnosError("${CnosError.MISSING_KEY}: $key")
        return value ?: throw CnosError("${CnosError.MISSING_KEY}: $key")
    }

    fun readOr(key: String, fallback: Any?): Any? {
        val (value, found) = readInternal(key, mutableSetOf())
        return if (found) value else fallback
    }

    fun value(path: String): Optional<Any> = read(toLogicalKey("value", path))
    fun secret(path: String): Optional<Any> = read(toLogicalKey("secret", path))
    fun meta(path: String): Optional<Any> = read(toLogicalKey("meta", path))
    fun publicKey(path: String): Optional<Any> = read(toLogicalKey("public", path))

    /** Returns the value at path as a map or list, parsing string values as JSON. */
    fun json(path: String): Optional<Any> {
        val raw = value(path)
        if (raw.isEmpty) return Optional.empty()
        if (raw.get() is String) {
            return try {
                Optional.ofNullable(jacksonObjectMapper().readValue<Any>(raw.get() as String))
            } catch (e: Exception) {
                Optional.empty()
            }
        }
        return raw
    }

    /** Returns the value at path as a PEM string, normalising literal \n to real newlines.
     * Checks value.* first, then secret.*. */
    fun pem(path: String): Optional<String> {
        val raw = value(path).let { if (it.isPresent) it else secret(path) }
        if (raw.isEmpty || raw.get() !is String) return Optional.empty()
        return Optional.of((raw.get() as String).replace("\\n", "\n"))
    }

    fun format(message: String): String {
        val templateRe = Regex("""\$\{([^}]+)}""")
        return templateRe.replace(message) { mr ->
            val key = mr.groupValues[1].trim()
            if (key.isEmpty()) return@replace mr.value
            val (value, found) = readInternal(key, mutableSetOf())
            if (found) JsCompat.jsLogStringifyValue(value) else mr.value
        }
    }

    fun toPublicEnv(options: ToPublicEnvOptions = ToPublicEnvOptions()): Map<String, String> {
        val prefix = resolvePublicPrefixInstance(options)
        val out = linkedMapOf<String, String>()
        entries.keys.sorted()
            .filter { entries[it]?.namespace == "public" }
            .forEach { key ->
                val srcKey = entries[key]?.aliasTo ?: key
                if (srcKey.startsWith("secret.")) return@forEach
                val (value, found) = readInternal(key, mutableSetOf())
                if (!found || value == null) return@forEach
                val subPath = if (key.startsWith("public.")) key.substring(7) else key
                val baseVar = fallbackPublicEnvVar(subPath)
                val envVar = if (!prefix.isNullOrEmpty() && !baseVar.startsWith(prefix)) prefix + baseVar else baseVar
                out[envVar] = JsCompat.jsStringifyValue(value)
            }
        return out
    }

    private fun resolvePublicPrefixInstance(options: ToPublicEnvOptions): String? {
        if (!options.prefix.isNullOrEmpty()) return options.prefix
        if (options.framework.isNullOrEmpty()) return null
        return manifest.frameworks[options.framework]
            ?: throw CnosError("cnos: unknown public framework prefix: ${options.framework}")
    }

    fun toObject(): Map<String, Any?> = toNamespaceObject("")

    fun toNamespace(namespace: String): Map<String, Any?> = toNamespaceObject(namespace.trim())

    private fun toNamespaceObject(namespace: String): Map<String, Any?> {
        val output = LinkedHashMap<String, Any?>()
        entries.keys.sorted().forEach { key ->
            val entry = entries[key] ?: return@forEach
            if (namespace.isNotEmpty() && namespace != entry.namespace) return@forEach
            val (value, found) = readInternal(key, mutableSetOf())
            if (!found) return@forEach
            val targetPath = if (namespace.isEmpty()) key else key.removePrefix("$namespace.")
            setNestedValue(output, targetPath.split("."), value)
        }
        return output
    }

    private fun setNestedValue(target: MutableMap<String, Any?>, segments: List<String>, value: Any?) {
        if (segments.isEmpty() || segments[0].isEmpty()) return
        if (segments.size == 1) { target[segments[0]] = value; return }
        @Suppress("UNCHECKED_CAST")
        val child: MutableMap<String, Any?> = when (val existing = target[segments[0]]) {
            is MutableMap<*, *> -> existing as MutableMap<String, Any?>
            else -> LinkedHashMap<String, Any?>().also { target[segments[0]] = it }
        }
        setNestedValue(child, segments.drop(1), value)
    }

    fun refreshSecrets() {
        val savedHydrated = HashMap(hydratedSecrets)
        val savedLocalCache = HashMap(localVaultCache)
        hydratedSecrets.clear()
        localVaultCache.clear()
        try {
            warmSecrets()
        } catch (e: CnosError) {
            hydratedSecrets.clear()
            hydratedSecrets.putAll(savedHydrated)
            localVaultCache.clear()
            localVaultCache.putAll(savedLocalCache)
            throw e
        }
    }

    fun refreshSecret(path: String) {
        val key = toLogicalKey("secret", path)
        val entry = entries[key] ?: return
        if (entry.secretRef == null) return

        val hadValue = hydratedSecrets.containsKey(key)
        val savedValue: Any? = hydratedSecrets[key]  // Any? from map getter; non-null when hadValue=true
        val vaultId = logicalKeyToVault[key]
        val savedVaultCache = vaultId?.let { localVaultCache[it]?.toMap() }

        hydratedSecrets.remove(key)
        vaultId?.let { localVaultCache.remove(it) }

        try {
            readSecret(key, entry.secretRef!!)
        } catch (e: CnosError) {
            if (hadValue && savedValue != null) hydratedSecrets[key] = savedValue
            if (vaultId != null) {
                if (savedVaultCache != null) localVaultCache[vaultId] = savedVaultCache
                else localVaultCache.remove(vaultId)
            }
            throw e
        }
    }

    private fun warmSecrets() {
        entries.keys.sorted().forEach { key ->
            val entry = entries[key] ?: return@forEach
            if (entry.secretRef == null) return@forEach
            readSecret(key, entry.secretRef!!)
        }
    }

    fun registerRuntimeProvider(namespace: String, provider: (String) -> Any?) {
        if (namespace == "process") throw CnosError("cnos: cannot override built-in runtime namespace \"process\"")
        if (!runtimeNamespaces.contains(namespace))
            throw CnosError("cnos: cannot register runtime provider for undeclared namespace \"$namespace\"")
        runtimeProviders[namespace] = provider
    }

    fun registerSecretVaultProviders(vararg factories: SecretVaultProviderFactory) {
        for (factory in factories) {
            if (factory.provider.isNotEmpty()) secretFactories[factory.provider] = factory
        }
    }

    // ================================================================
    // Internal read path
    // ================================================================

    internal fun readInternal(key: String, stack: MutableSet<String>): Pair<Any?, Boolean> {
        val entry = entries[key]
        if (entry == null) {
            val dot = key.indexOf('.')
            if (dot > 0) {
                val ns = key.substring(0, dot)
                val rest = key.substring(dot + 1)
                val provider = runtimeProviders[ns]
                if (provider != null) return Pair(provider(rest), true)
            }
            return Pair(null, false)
        }

        if (!entry.aliasTo.isNullOrEmpty()) {
            if (key in stack) throw CnosError("cnos: circular alias for $key")
            return readInternal(entry.aliasTo!!, (stack + key).toMutableSet())
        }

        if (entry.secretRef != null) return readSecret(entry.key, entry.secretRef)

        val formula = entry.formula
        if (formula != null) {
            if (key in stack) throw CnosError("cnos: cyclic derived dependency on $key")
            if (!formula.isRuntimeDependent && entry.isFormulaCached) {
                return Pair(entry.getFormulaCache(), true)
            }
            val next = (stack + key).toMutableSet()
            val value = Derive.evaluate(key, formula) { ref -> readInternal(ref, next) }
            if (!formula.isRuntimeDependent) entry.setFormulaCache(value)
            return Pair(value, true)
        }

        return Pair(entry.value, true)
    }

    // ================================================================
    // Secret hydration
    // ================================================================

    private fun readSecret(key: String, ref: SecretReference): Pair<Any?, Boolean> {
        encryptedSecrets?.get(key)?.let { return Pair(it, true) }
        hydratedSecrets[key]?.let { v -> return if (v === ABSENT_SECRET) Pair(null, true) else Pair(v, true) }

        val definitions = secretVaultDefinitions(ref)
        var lastError: Exception? = null
        for (def in definitions) {
            try {
                val value = readSecretWithDef(key, ref, def)
                if (value != null) {
                    hydratedSecrets[key] = value
                    return Pair(value, true)
                }
            } catch (e: Exception) {
                lastError = e
            }
        }
        if (lastError != null) throw if (lastError is CnosError) lastError else CnosError(lastError.message ?: "secret error", lastError)
        hydratedSecrets[key] = ABSENT_SECRET
        return Pair(null, true)
    }

    private fun secretVaultDefinitions(ref: SecretReference): List<VaultDefinition> {
        val primary = secretVaultDefinition(ref)
        return listOf(primary) + primary.fallback
    }

    private fun secretVaultDefinition(ref: SecretReference): VaultDefinition {
        val def = vaults[ref.vault]
        if (def != null) {
            return if (def.provider.isEmpty()) def.withProvider(ref.provider) else def
        }
        val provider = ref.provider.ifBlank { "local" }
        return VaultDefinition(provider, VaultAuth(VaultResolver.defaultVaultMethod(provider)))
    }

    private fun readSecretWithDef(key: String, ref: SecretReference, def: VaultDefinition): Any? {
        return when (def.provider) {
            "environment", "github-secrets" -> readEnvSecret(ref, def)
            "local" -> {
                val secrets = localVaultSecrets(ref.vault)
                secrets[ref.ref]
            }
            else -> {
                val factory = secretFactories[def.provider]
                    ?: throw CnosError("cnos: unsupported vault provider: ${def.provider}")
                val refsByKey = refsForVault(ref.vault, def)
                hydrateCustomVault(ref.vault, def, refsByKey, factory)
                hydratedSecrets[key]
            }
        }
    }

    private fun readEnvSecret(ref: SecretReference, def: VaultDefinition): Any? {
        env.get(ref.ref)?.let { return it }
        if (!ref.envVar.isNullOrEmpty()) env.get(ref.envVar)?.let { return it }
        def.mapping.entries.firstOrNull { it.value == ref.ref }?.let { env.get(it.key)?.let { v -> return v } }
        return null
    }

    private fun localVaultSecrets(vaultId: String): Map<String, String> {
        localVaultCache[vaultId]?.let { return it }
        val metaFile = File(secretHome, "vaults/$vaultId/meta.yml")
        if (!metaFile.isFile) throw CnosError("cnos: missing CNOS vault metadata for \"$vaultId\"")
        val meta = LocalVault.parseMetadata(metaFile.readBytes())
        val key = VaultResolver.resolveLocalVaultKey(secretHome, vaultId, meta, vaults[vaultId], env)
        val secrets = LocalVault.readVaultSecrets(secretHome, vaultId, key)
        localVaultCache[vaultId] = secrets
        return secrets
    }

    private fun refsForVault(vaultId: String, def: VaultDefinition): Map<String, String> {
        val out = linkedMapOf<String, String>()
        entries.keys.sorted().forEach { k ->
            val e = entries[k] ?: return@forEach
            if (e.secretRef == null || e.secretRef.vault != vaultId) return@forEach
            if (hydratedSecrets.containsKey(k)) return@forEach
            val defs = secretVaultDefinitions(e.secretRef)
            if (defs.any { it.provider == def.provider }) out[k] = e.secretRef.ref
        }
        return out
    }

    private fun hydrateCustomVault(
        vaultId: String, def: VaultDefinition,
        refsByKey: Map<String, String>, factory: SecretVaultProviderFactory
    ) {
        val refs = refsByKey.values.distinct().sorted()
        val provider = factory.create(vaultId, def)
        val auth = VaultResolver.resolveVaultAuth(vaultId, def, env)
        provider.authenticate(auth)
        val values = provider.batchGet(refs)
        for ((key, ref) in refsByKey) {
            if (!hydratedSecrets.containsKey(key)) {
                val v = values[ref]
                if (v != null) hydratedSecrets[key] = v
            }
        }
    }

    // ================================================================
    // Construction helpers
    // ================================================================

    private fun populateEntries() {
        val explicitNs = mutableSetOf("config", "flags", "process")
        projection?.meta?.namespaces?.let { explicitNs.addAll(it) }

        projection?.values?.forEach { (raw, value) ->
            val key = projectionLogicalKey(raw, explicitNs)
            entries[key] = RuntimeEntry(key, namespaceForKey(key), value)
        }

        projection?.derived?.forEach { (raw, formula) ->
            val key = projectionLogicalKey(raw, explicitNs)
            val parsed = Derive.parseDerivedFormula(formula)
            entries[key] = RuntimeEntry(key, namespaceForKey(key), formula = parsed)
        }

        projection?.secretRefs?.forEach { (raw, ref) ->
            val key = toLogicalKey("secret", raw)
            val r = if (ref.vault.isEmpty()) ref.withVault("default") else ref
            entries[key] = RuntimeEntry(key, "secret", secretRef = r)
            logicalKeyToVault[key] = r.vault
        }

        projection?.publicKeys?.forEach { raw ->
            var sourceKey = raw
            if (!entries.containsKey(sourceKey)) sourceKey = toLogicalKey("value", raw)
            if (!entries.containsKey(sourceKey)) return@forEach
            if (sourceKey.startsWith("secret.")) return@forEach
            val publicKey = toLogicalKey("public", raw)
            entries[publicKey] = RuntimeEntry(publicKey, "public", aliasTo = sourceKey, promotedFrom = sourceKey)
        }

        // Meta entries from projection
        projection?.let { p ->
            entries["meta.profile"] = RuntimeEntry("meta.profile", "meta", p.profile)
            entries["meta.workspace"] = RuntimeEntry("meta.workspace", "meta", p.workspace)
            entries["meta.cnos_version"] = RuntimeEntry("meta.cnos_version", "meta", p.meta.cnosVersion)
        }
    }

    private fun initRuntimeProviders(namespaces: List<String>) {
        runtimeNamespaces.addAll(namespaces)
        if ("process" in runtimeNamespaces) {
            runtimeProviders["process"] = ::processProvider
        }
    }

    private fun processProvider(path: String): Any? = when {
        path.startsWith("env.") -> env.get(path.substring(4))
        path == "cwd" -> File(".").canonicalPath
        path == "platform" -> JsCompat.nodePlatform()
        path == "arch" -> JsCompat.nodeArch()
        path == "pid" -> ProcessHandle.current().pid()
        else -> null
    }

    private fun prepareDerivedEntries() {
        val keys = entries.keys.filter { entries[it]?.formula != null }.sorted()
        val resolved = mutableSetOf<String>()
        val visiting = mutableSetOf<String>()
        for (key in keys) visitDerived(key, resolved, visiting)
    }

    private fun visitDerived(key: String, resolved: MutableSet<String>, visiting: MutableSet<String>) {
        if (key in resolved) return
        if (key in visiting) throw CnosError("cnos: unable to resolve derived config key $key because of a recursive dependency on $key")

        val entry = entries[key]
        if (entry == null || entry.formula == null) { resolved.add(key); return }

        visiting.add(key)
        val formula = entry.formula!!
        var runtimeDependent = formula.isRuntimeDependent
        val runtimeRefs = formula.runtimeRefs.toMutableList()

        for (ref in (formula.deps + formula.runtimeRefs).distinct()) {
            val ns = namespaceForKey(ref)
            if (ns.isEmpty()) continue
            if (ns in runtimeNamespaces) {
                runtimeDependent = true
                if (ref !in runtimeRefs) runtimeRefs.add(ref)
                continue
            }
            val dep = entries[ref]
            if (dep?.formula != null) {
                visitDerived(ref, resolved, visiting)
                if (dep.formula!!.isRuntimeDependent) runtimeDependent = true
            }
        }

        formula.runtimeRefs = Derive.uniqueSorted(runtimeRefs)
        formula.isRuntimeDependent = runtimeDependent

        visiting.remove(key)
        resolved.add(key)
    }

    // ================================================================
    // Static helpers
    // ================================================================

    companion object {
        private val ABSENT_SECRET = Any()
        private const val PROJECTION_ENV_VAR = "__CNOS_PROJECTION__"
        private const val GRAPH_ENV_VAR = "__CNOS_GRAPH__"
        private const val SECRET_PAYLOAD_ENV_VAR = "__CNOS_SECRET_PAYLOAD__"
        private const val SESSION_KEY_ENV_VAR = "__CNOS_SESSION_KEY__"
        private const val PROJECTION_FILE_NAME = ".cnos-server.json"
        private const val CNOSRC_FILE_NAME = ".cnosrc.yml"

        private val MAPPER = jacksonObjectMapper()

        @JvmStatic
        fun load(options: CnosOptions = CnosOptions.defaults()): CnosRuntime {
            val env = Environment.of(options.environment)
            val secretHome = resolveSecretHome(env, options.secretHome)

            if (options.projectionData != null && options.projectionData.isNotEmpty())
                return buildFromProjection(options.projectionData, env, secretHome, options.secretVaultProviders)

            if (!options.projectionPath.isNullOrEmpty()) {
                val path = resolvePathFromWorkingDir(options.workingDir, options.projectionPath)
                return buildFromProjection(File(path).readBytes(), env, secretHome, options.secretVaultProviders)
            }

            env.get(GRAPH_ENV_VAR)?.takeIf { it.isNotEmpty() }?.let {
                return buildFromGraph(it.toByteArray(), env, secretHome, options.secretVaultProviders)
            }

            env.get(PROJECTION_ENV_VAR)?.takeIf { it.isNotEmpty() }?.let {
                return buildFromProjection(it.toByteArray(), env, secretHome, options.secretVaultProviders)
            }

            val parsedArgs = parseCliArgs(getProcessArgv())

            // Explicit runtime projection path: --cnos-projection or CNOS_SERVER_PROJECTION_PATH
            // Checked before file auto-discovery so it always wins over .cnos-server.json on disk.
            val runtimeProj = parsedArgs["--cnos-projection"]?.takeIf { it.isNotEmpty() }
                ?: env.get("CNOS_SERVER_PROJECTION_PATH")?.takeIf { it.isNotEmpty() }
            if (runtimeProj != null) {
                val resolved = resolvePathFromWorkingDir(options.workingDir, runtimeProj)
                return buildFromProjection(File(resolved).readBytes(), env, secretHome, options.secretVaultProviders)
            }

            val projPath = findProjectionPath(options.workingDir)
            if (projPath != null)
                return buildFromProjection(File(projPath).readBytes(), env, secretHome, options.secretVaultProviders)

            // Dynamic mode: CNOS_DYNAMIC=1 or --cnos-dynamic — suppress projection-not-found.
            val isDynamic = parsedArgs["--cnos-dynamic"] == "true" ||
                env.get("CNOS_DYNAMIC")?.lowercase()?.let { it == "1" || it == "true" || it == "yes" } == true
            if (isDynamic)
                return buildDynamic(env, secretHome, options.secretVaultProviders)

            throw CnosError(CnosError.PROJECTION_NOT_FOUND)
        }

        @JvmStatic
        fun loadProjection(data: ByteArray, options: CnosOptions = CnosOptions.defaults()): CnosRuntime {
            val env = Environment.of(options.environment)
            val secretHome = resolveSecretHome(env, options.secretHome)
            return buildFromProjection(data, env, secretHome, options.secretVaultProviders)
        }

        private fun buildFromProjection(
            data: ByteArray, env: Environment, secretHome: String,
            factories: List<SecretVaultProviderFactory>
        ): CnosRuntime {
            val projection = ServerProjection.parse(data)
            val manifest = BootstrappedManifest.fromProjection(projection)
            val encrypted = decryptSecretPayload(env)

            val pa0 = parseCliArgs(getProcessArgv())
            val rt = CnosRuntime(projection, manifest, env, secretHome, mutableMapOf(), mutableSetOf(), encrypted,
                pa0, loadPatchFile(detectPatchPath(pa0, env)))
            factories.forEach { if (it.provider.isNotEmpty()) rt.secretFactories[it.provider] = it }
            rt.populateEntries()
            rt.initRuntimeProviders(projection.runtimeNamespaces)
            rt.prepareDerivedEntries()
            return rt
        }

        private fun buildFromGraph(
            data: ByteArray, env: Environment, secretHome: String,
            factories: List<SecretVaultProviderFactory>
        ): CnosRuntime {
            val graph = GraphParser.parseRuntimeGraph(data)
            val manifest = GraphParser.bootstrappedManifestFromGraph(graph)
            val encrypted = decryptSecretPayload(env)

            val pa1 = parseCliArgs(getProcessArgv())
            val rt = CnosRuntime(null, manifest, env, secretHome, mutableMapOf(), mutableSetOf(), encrypted,
                pa1, loadPatchFile(detectPatchPath(pa1, env)))
            factories.forEach { if (it.provider.isNotEmpty()) rt.secretFactories[it.provider] = it }

            for (resolved in graph.entries) {
                val (entry, vaultId) = GraphParser.runtimeEntryFromGraph(resolved)
                if (vaultId != null) rt.logicalKeyToVault[resolved.key] = vaultId
                rt.entries[resolved.key] = entry
            }

            if (graph.overrides.isNotEmpty()) rt.graphOverrides = graph.overrides

            val runtimeNsList = manifest.namespaces.entries
                .filter { it.value.runtime }
                .map { it.key }
            rt.initRuntimeProviders(runtimeNsList)
            rt.prepareDerivedEntries()
            return rt
        }

        private fun buildDynamic(
            env: Environment, secretHome: String,
            factories: List<SecretVaultProviderFactory>
        ): CnosRuntime {
            val manifest = BootstrappedManifest(
                BootstrappedManifest.DEFAULT_NAMESPACES.toMap(),
                BootstrappedManifest.DEFAULT_FRAMEWORKS.toMap(),
                emptyMap(), emptyMap()
            )
            val encrypted = decryptSecretPayload(env)
            val pa = parseCliArgs(getProcessArgv())
            val rt = CnosRuntime(null, manifest, env, secretHome, mutableMapOf(), mutableSetOf(), encrypted,
                pa, loadPatchFile(detectPatchPath(pa, env)))
            factories.forEach { if (it.provider.isNotEmpty()) rt.secretFactories[it.provider] = it }
            rt.initRuntimeProviders(listOf("process"))
            rt.prepareDerivedEntries()
            return rt
        }

        private fun decryptSecretPayload(env: Environment): Map<String, Any?>? {
            val payload = env.get(SECRET_PAYLOAD_ENV_VAR)?.takeIf { it.isNotEmpty() } ?: return null
            val sessionKey = env.get(SESSION_KEY_ENV_VAR)?.takeIf { it.isNotEmpty() } ?: return null
            val plain = LocalVault.decryptSessionPayload(sessionKey, payload)
            return MAPPER.readValue(plain)
        }

        private fun findProjectionPath(workingDir: String?): String? {
            val cwd = if (!workingDir.isNullOrEmpty()) File(workingDir).absoluteFile else File(".").absoluteFile
            val direct = File(cwd, PROJECTION_FILE_NAME)
            if (direct.isFile) return direct.path
            var current = cwd
            repeat(4) {
                val rc = File(current, CNOSRC_FILE_NAME)
                if (rc.isFile) {
                    val proj = File(current, PROJECTION_FILE_NAME)
                    if (proj.isFile) return proj.path
                }
                current = current.parentFile ?: return null
            }
            return null
        }

        private fun resolveSecretHome(env: Environment, override: String?): String {
            if (!override.isNullOrBlank()) return expandHome(override.trim())
            val envHome = env.get("CNOS_SECRET_HOME")?.trim()
            if (!envHome.isNullOrBlank()) return expandHome(envHome)
            return expandHome("~/.cnos/secrets")
        }

        private fun expandHome(path: String): String {
            if (path == "~") return System.getProperty("user.home", "")
            if (path.startsWith("~/")) return System.getProperty("user.home", "") + "/" + path.substring(2)
            return File(path).absolutePath
        }

        private fun resolvePathFromWorkingDir(workingDir: String?, target: String): String {
            if (File(target).isAbsolute) return target
            val base = if (!workingDir.isNullOrEmpty()) File(workingDir).absoluteFile else File(".").absoluteFile
            return File(base, target).absolutePath
        }

        internal fun namespaceForKey(key: String): String {
            val dot = key.indexOf('.')
            return if (dot > 0) key.substring(0, dot) else ""
        }

        internal fun toLogicalKey(namespace: String, path: String): String {
            val p = path.trim()
            if (p.startsWith("$namespace.")) return p
            if (p.isEmpty()) return "$namespace."
            return "$namespace.$p"
        }

        private fun projectionLogicalKey(raw: String, explicitNs: Set<String>): String {
            if (raw.startsWith("value.") || raw.startsWith("public.")) return raw
            val first = if (raw.contains('.')) raw.substring(0, raw.indexOf('.')) else raw
            if (first in explicitNs) return raw
            return toLogicalKey("value", raw)
        }

        internal fun fallbackPublicEnvVar(subPath: String): String {
            val sb = StringBuilder()
            var lastUnderscore = false
            for (c in subPath) {
                when {
                    c in 'a'..'z' -> { sb.append(c.uppercaseChar()); lastUnderscore = false }
                    c in 'A'..'Z' || c in '0'..'9' -> { sb.append(c); lastUnderscore = false }
                    else -> if (!lastUnderscore) { sb.append('_'); lastUnderscore = true }
                }
            }
            return sb.toString().trim('_')
        }

        private fun getProcessArgv(): Array<String> {
            val prop = System.getProperty("sun.java.command") ?: return emptyArray()
            val parts = prop.split("\\s+".toRegex())
            return if (parts.size <= 1) emptyArray() else parts.drop(1).toTypedArray()
        }

        private fun parseCliArgs(args: Array<String>): Map<String, String> {
            val result = mutableMapOf<String, String>()
            var i = 0
            while (i < args.size) {
                val arg = args[i]
                if (!arg.startsWith("-")) { i++; continue }
                val eq = arg.indexOf('=')
                if (eq >= 0) { result[arg.substring(0, eq)] = arg.substring(eq + 1); i++; continue }
                if (i + 1 < args.size && !args[i + 1].startsWith("-")) {
                    result[arg] = args[i + 1]; i += 2
                } else { result[arg] = "true"; i++ }
            }
            return result
        }

        private fun detectPatchPath(parsedArgs: Map<String, String>, env: Environment): String? {
            val flagVal = parsedArgs["--cnos-patch"]
            if (!flagVal.isNullOrEmpty()) return flagVal
            val envVal = env.get("CNOS_PATCH_FILE")
            return if (!envVal.isNullOrEmpty()) envVal else null
        }

        private fun loadPatchFile(path: String?): Map<String, Any?> {
            if (path.isNullOrEmpty()) return emptyMap()
            val text = try {
                java.io.File(path).readText(Charsets.UTF_8)
            } catch (_: Exception) {
                return emptyMap()
            }
            val ext = path.substringAfterLast('.', "").lowercase()
            if (ext == "json") {
                return try {
                    jacksonObjectMapper().readValue<Map<String, Any?>>(text)
                } catch (_: Exception) { emptyMap() }
            }
            return parsePatchProperties(text)
        }

        private fun parsePatchProperties(text: String): Map<String, Any?> {
            val result = mutableMapOf<String, Any?>()
            for (line in text.lines()) {
                var trimmed = line.trim()
                if (trimmed.isEmpty() || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
                // Bash-style dotenv: "export KEY=value"
                if (trimmed.startsWith("export ")) trimmed = trimmed.removePrefix("export ").trim()
                val eq = trimmed.indexOf('=')
                if (eq < 0) continue
                val key = trimmed.substring(0, eq).trim()
                var raw = trimmed.substring(eq + 1).trim()
                if (key.isEmpty()) continue
                // Strip inline comments from unquoted values: KEY=value # comment
                if (!raw.startsWith('"') && !raw.startsWith('\'')) {
                    raw = when {
                        raw.startsWith('#') -> ""
                        raw.contains(" #") -> raw.substring(0, raw.indexOf(" #")).trim()
                        else -> raw
                    }
                }
                if (raw.isEmpty()) {
                    System.err.println("cnos [warn]: patch file key \"$key\" has empty value — skipping")
                    continue
                }
                result[key] = coercePropertyValue(raw)
            }
            return result
        }

        private fun coercePropertyValue(raw: String): Any? = when {
            raw == "true" -> true
            raw == "false" -> false
            raw == "null" -> null
            (raw.startsWith('"') && raw.endsWith('"')) ||
                    (raw.startsWith('\'') && raw.endsWith('\'')) -> raw.substring(1, raw.length - 1)
            else -> raw.toLongOrNull() ?: raw.toDoubleOrNull() ?: raw
        }

        private val defaultPriority = listOf("arg", "env", "cnos")

        private data class CoercionResult(val value: Any?, val valid: Boolean)

        private fun coerceOverrideValue(raw: String, type: String?): CoercionResult {
            if (raw.isEmpty()) return CoercionResult(null, false)
            return when (type) {
                "number" -> raw.toDoubleOrNull()?.let { CoercionResult(it, true) } ?: CoercionResult(null, false)
                "boolean" -> CoercionResult(raw == "true" || raw == "1" || raw == "yes", true)
                "object", "array" -> try {
                    CoercionResult(jacksonObjectMapper().readValue(raw, Any::class.java), true)
                } catch (_: Exception) { CoercionResult(null, false) }
                else -> CoercionResult(raw, true)
            }
        }

        private fun applyOverride(
            spec: OverrideSpec,
            cnosVal: Any?,
            cnosFound: Boolean,
            parsedArgs: Map<String, String>,
            env: Environment,
            key: String = ""
        ): Optional<Any> {
            val priority = spec.priority.ifEmpty { defaultPriority }
            val keyLabel = if (key.isEmpty()) "" else " for \"$key\""
            for (source in priority) {
                when (source) {
                    "arg" -> spec.arg.forEach { flag ->
                        val v = parsedArgs[flag] ?: return@forEach
                        if (v.isEmpty()) {
                            System.err.println("cnos [warn]: arg \"$flag\" has empty value — skipping override$keyLabel")
                            return@forEach
                        }
                        val r = coerceOverrideValue(v, spec.type)
                        if (!r.valid) {
                            System.err.println("cnos [warn]: arg \"$flag\" value \"$v\" cannot be coerced to ${spec.type ?: "string"} — skipping override$keyLabel")
                            return@forEach
                        }
                        return Optional.ofNullable(r.value)
                    }
                    "env" -> spec.env.forEach { varName ->
                        val v = env.get(varName)
                        if (v.isNullOrEmpty()) return@forEach
                        val r = coerceOverrideValue(v, spec.type)
                        if (!r.valid) {
                            System.err.println("cnos [warn]: env \"$varName\" value \"$v\" cannot be coerced to ${spec.type ?: "string"} — skipping override$keyLabel")
                            return@forEach
                        }
                        return Optional.ofNullable(r.value)
                    }
                    "cnos" -> if (cnosFound) return Optional.ofNullable(cnosVal)
                }
            }
            return if (cnosFound) Optional.ofNullable(cnosVal) else Optional.empty()
        }

    }
}
