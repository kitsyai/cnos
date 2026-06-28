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
    private val encryptedSecrets: Map<String, Any?>?
) {
    private val runtimeProviders = ConcurrentHashMap<String, (String) -> Any?>()
    private val hydratedSecrets = ConcurrentHashMap<String, Any>()
    private val localVaultCache = ConcurrentHashMap<String, Map<String, String>>()
    private val logicalKeyToVault = ConcurrentHashMap<String, String>()
    private val vaults: Map<String, VaultDefinition> = manifest.vaults
    private val secretFactories = ConcurrentHashMap<String, SecretVaultProviderFactory>()

    fun getProjection(): ServerProjection? = projection

    // ================================================================
    // Public API
    // ================================================================

    fun read(key: String): Optional<Any> {
        val (value, found) = readInternal(key, mutableSetOf())
        return if (found) Optional.ofNullable(value) else Optional.empty()
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

        for (ref in formula.deps) {
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

            val projPath = findProjectionPath(options.workingDir)
                ?: throw CnosError(CnosError.PROJECTION_NOT_FOUND)
            return buildFromProjection(File(projPath).readBytes(), env, secretHome, options.secretVaultProviders)
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

            val rt = CnosRuntime(projection, manifest, env, secretHome, mutableMapOf(), mutableSetOf(), encrypted)
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

            val rt = CnosRuntime(null, manifest, env, secretHome, mutableMapOf(), mutableSetOf(), encrypted)
            factories.forEach { if (it.provider.isNotEmpty()) rt.secretFactories[it.provider] = it }

            for (resolved in graph.entries) {
                val (entry, vaultId) = GraphParser.runtimeEntryFromGraph(resolved)
                if (vaultId != null) rt.logicalKeyToVault[resolved.key] = vaultId
                rt.entries[resolved.key] = entry
            }

            val runtimeNsList = manifest.namespaces.entries
                .filter { it.value.runtime }
                .map { it.key }
            rt.initRuntimeProviders(runtimeNsList)
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

    }
}
