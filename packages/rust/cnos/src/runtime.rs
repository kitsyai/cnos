use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, RwLock};
use std::sync::atomic::{AtomicBool, Ordering};
use serde_json::Value;

use crate::derive::{
    evaluate_derived_formula, parse_derived_formula, parse_raw_derived_value,
    is_derived_value, unique_sorted_strings, ParsedFormula,
};
use crate::discover::{expand_home_path, find_projection_path, resolve_path_from_working_dir};
use crate::env::CnosEnvironment;
use crate::error::CnosError;
use crate::jscompat::{js_stringify_value, js_log_stringify_value, node_arch, node_platform};
use crate::manifest::{bootstrapped_manifest_from_projection, BootstrappedManifest, NamespaceDef};
use crate::projection::{
    parse_projection, SecretRefRaw, ServerProjection,
    GRAPH_ENV_VAR, PROJECTION_ENV_VAR, SECRET_PAYLOAD_ENV_VAR, SESSION_KEY_ENV_VAR,
};
use crate::secrets::{decrypt_secret_payload_from_env, read_local_vault_secrets, resolve_secret_home};
use crate::vault::{
    default_vault_method, get_vault_passphrase_env_var, get_vault_session_key_env_var,
    normalize_vault_token, vault_def_for_provider, SecretVaultProvider, SecretVaultProviderFactory,
    VaultAuthConfig, VaultDefinition,
};
use crate::projection::VaultDef;

// ---- Options ----

pub struct Options {
    pub projection_path: Option<String>,
    pub projection_data: Option<Vec<u8>>,
    pub working_dir: Option<String>,
    pub environment: Option<HashMap<String, String>>,
    pub secret_home: Option<String>,
    pub secret_vault_providers: Vec<SecretVaultProviderFactory>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            projection_path: None,
            projection_data: None,
            working_dir: None,
            environment: None,
            secret_home: None,
            secret_vault_providers: Vec::new(),
        }
    }
}

// ---- Runtime entry ----

pub struct FormulaCacheCell {
    cached: AtomicBool,
    value: Mutex<Option<Value>>,
}

impl FormulaCacheCell {
    pub fn new() -> Self {
        FormulaCacheCell { cached: AtomicBool::new(false), value: Mutex::new(None) }
    }
    fn get(&self) -> Option<Value> {
        if self.cached.load(Ordering::Relaxed) {
            self.value.lock().unwrap().clone()
        } else {
            None
        }
    }
    fn set(&self, v: Option<Value>) {
        *self.value.lock().unwrap() = v;
        self.cached.store(true, Ordering::Release);
    }
    fn is_cached(&self) -> bool {
        self.cached.load(Ordering::Acquire)
    }
}

pub struct RuntimeProvenance {
    pub source_id: String,
    pub plugin_id: String,
    pub workspace_id: String,
}

pub struct RuntimeEntry {
    pub key: String,
    pub namespace: String,
    pub value: Option<Value>,
    pub alias_to: Option<String>,
    pub promoted_from: Option<String>,
    pub formula: Option<ParsedFormula>,
    pub secret_ref: Option<SecretRefRaw>,
    pub winner: RuntimeProvenance,
    pub formula_cache: FormulaCacheCell,
}

// ---- ToEnv / ToPublicEnv options ----

#[derive(Default)]
pub struct ToEnvOptions {
    pub include_secrets: bool,
}

#[derive(Default)]
pub struct ToPublicEnvOptions {
    pub framework: Option<String>,
    pub prefix: Option<String>,
}

// ---- Runtime ----

pub struct CnosRuntime {
    projection: ServerProjection,
    manifest: BootstrappedManifest,
    profile_source: String,
    workspace_id: String,
    workspace_source: String,
    workspace_chain: Vec<String>,
    graph_bootstrapped: bool,
    env: CnosEnvironment,
    secret_home: String,
    entries: HashMap<String, RuntimeEntry>,
    sources: HashMap<String, String>,
    runtime_namespaces: HashSet<String>,
    runtime_providers: RwLock<HashMap<String, Box<dyn Fn(&str) -> Option<Value> + Send + Sync>>>,
    encrypted_secrets: HashMap<String, Value>,
    hydrated_secrets: Mutex<HashMap<String, Value>>,
    local_vault_cache: Mutex<HashMap<String, HashMap<String, String>>>,
    logical_key_to_vault: HashMap<String, String>,
    secret_factories: Mutex<HashMap<String, SecretVaultProviderFactory>>,
}

unsafe impl Send for CnosRuntime {}
unsafe impl Sync for CnosRuntime {}

impl CnosRuntime {
    pub fn load(options: Options) -> Result<Self, CnosError> {
        let env = CnosEnvironment::new(options.environment.clone());
        let secret_home = resolve_secret_home(&env, options.secret_home.as_deref())?;

        if let Some(data) = options.projection_data {
            return Self::new_from_bytes(&data, env, secret_home, options.secret_vault_providers);
        }
        if let Some(ref path) = options.projection_path {
            let full_path = resolve_path_from_working_dir(options.working_dir.as_deref(), path)?;
            let bytes = std::fs::read(&full_path)
                .map_err(|e| CnosError::IoError(format!("read projection file {:?}: {}", full_path, e)))?;
            return Self::new_from_bytes(&bytes, env, secret_home, options.secret_vault_providers);
        }

        if let Some(serialized) = env.get(GRAPH_ENV_VAR).filter(|v| !v.is_empty()) {
            return Self::new_from_graph(serialized.as_bytes(), env, secret_home, options.secret_vault_providers);
        }
        if let Some(serialized) = env.get(PROJECTION_ENV_VAR).filter(|v| !v.is_empty()) {
            return Self::new_from_bytes(serialized.as_bytes(), env, secret_home, options.secret_vault_providers);
        }

        if let Some(path) = find_projection_path(options.working_dir.as_deref())? {
            let bytes = std::fs::read(&path)
                .map_err(|e| CnosError::IoError(format!("read projection file {:?}: {}", path, e)))?;
            return Self::new_from_bytes(&bytes, env, secret_home, options.secret_vault_providers);
        }

        Err(CnosError::ProjectionNotFound)
    }

    pub fn load_projection(data: &[u8], options: Options) -> Result<Self, CnosError> {
        let env = CnosEnvironment::new(options.environment.clone());
        let secret_home = resolve_secret_home(&env, options.secret_home.as_deref())?;
        Self::new_from_bytes(data, env, secret_home, options.secret_vault_providers)
    }

    pub fn load_projection_file(path: &str, options: Options) -> Result<Self, CnosError> {
        let env = CnosEnvironment::new(options.environment.clone());
        let secret_home = resolve_secret_home(&env, options.secret_home.as_deref())?;
        let full_path = resolve_path_from_working_dir(options.working_dir.as_deref(), path)?;
        let bytes = std::fs::read(&full_path)
            .map_err(|e| CnosError::IoError(format!("read projection file {:?}: {}", full_path, e)))?;
        Self::new_from_bytes(&bytes, env, secret_home, options.secret_vault_providers)
    }

    fn new_from_bytes(
        source: &[u8],
        env: CnosEnvironment,
        secret_home: String,
        factories: Vec<SecretVaultProviderFactory>,
    ) -> Result<Self, CnosError> {
        let projection = parse_projection(source)?;
        let encrypted_secrets = decrypt_secret_payload_from_env(&env)?;
        let manifest = bootstrapped_manifest_from_projection(&projection);
        let workspace_id = projection.workspace.clone();

        let factory_map: HashMap<String, SecretVaultProviderFactory> =
            factories.into_iter().filter(|f| !f.provider.is_empty()).map(|f| (f.provider.clone(), f)).collect();

        let mut rt = CnosRuntime {
            manifest,
            profile_source: "manifest-default".into(),
            workspace_id: workspace_id.clone(),
            workspace_source: "implicit".into(),
            workspace_chain: vec![workspace_id],
            graph_bootstrapped: false,
            env,
            secret_home,
            entries: HashMap::new(),
            sources: HashMap::new(),
            runtime_namespaces: HashSet::new(),
            runtime_providers: RwLock::new(HashMap::new()),
            encrypted_secrets,
            hydrated_secrets: Mutex::new(HashMap::new()),
            local_vault_cache: Mutex::new(HashMap::new()),
            logical_key_to_vault: HashMap::new(),
            secret_factories: Mutex::new(factory_map),
            projection,
        };

        rt.populate_entries()?;
        rt.initialize_runtime_providers();
        rt.prepare_derived_entries()?;
        Ok(rt)
    }

    fn new_from_graph(
        source: &[u8],
        env: CnosEnvironment,
        secret_home: String,
        factories: Vec<SecretVaultProviderFactory>,
    ) -> Result<Self, CnosError> {
        use crate::graph::{parse_runtime_graph, runtime_entry_from_graph};

        let graph = parse_runtime_graph(source)?;
        let encrypted_secrets = decrypt_secret_payload_from_env(&env)?;
        let manifest = crate::graph::bootstrapped_manifest_from_graph(&graph);
        let workspace_id = graph.workspace.workspace_id.clone();
        let workspace_source = graph.workspace.workspace_source.clone();
        let workspace_chain = graph.workspace.workspace_chain.clone();
        let profile_source = graph.profile_source.clone();

        let factory_map: HashMap<String, SecretVaultProviderFactory> =
            factories.into_iter().filter(|f| !f.provider.is_empty()).map(|f| (f.provider.clone(), f)).collect();

        // Build a dummy projection for workspace/profile info
        let dummy_proj = ServerProjection {
            version: 1,
            workspace: workspace_id.clone(),
            profile: graph.profile.clone(),
            resolved_at: graph.resolved_at.clone(),
            config_hash: String::new(),
            values: HashMap::new(),
            derived: HashMap::new(),
            secret_refs: HashMap::new(),
            vaults: HashMap::new(),
            public_keys: vec![],
            runtime_namespaces: vec![],
            meta: crate::projection::ProjectionMeta {
                workspace: workspace_id.clone(),
                profile: graph.profile.clone(),
                cnos_version: "bootstrapped".into(),
                namespaces: vec![],
            },
        };

        let mut rt = CnosRuntime {
            manifest,
            profile_source,
            workspace_id: workspace_id.clone(),
            workspace_source,
            workspace_chain,
            graph_bootstrapped: true,
            env,
            secret_home,
            entries: HashMap::new(),
            sources: HashMap::new(),
            runtime_namespaces: HashSet::new(),
            runtime_providers: RwLock::new(HashMap::new()),
            encrypted_secrets,
            hydrated_secrets: Mutex::new(HashMap::new()),
            local_vault_cache: Mutex::new(HashMap::new()),
            logical_key_to_vault: HashMap::new(),
            secret_factories: Mutex::new(factory_map),
            projection: dummy_proj,
        };

        for resolved in graph.entries {
            let key = resolved.key.clone();
            let source_id = resolved.winner.source_id.clone();
            let entry = runtime_entry_from_graph(resolved)?;
            if let Some(ref sr) = entry.secret_ref {
                if !sr.vault.is_empty() {
                    rt.logical_key_to_vault.insert(key.clone(), sr.vault.clone());
                }
            }
            rt.sources.insert(key.clone(), source_id);
            rt.entries.insert(key, entry);
        }

        // Collect runtime namespaces from manifest
        let ns_keys: Vec<String> = rt.manifest.runtime_namespaces.keys().cloned().collect();
        rt.initialize_runtime_providers_list(&ns_keys);
        rt.prepare_derived_entries()?;
        Ok(rt)
    }

    // ---- entry population ----

    fn populate_entries(&mut self) -> Result<(), CnosError> {
        let explicit_ns: HashSet<String> = {
            let mut s: HashSet<String> = ["config", "flags", "process"].iter().map(|&s| s.to_string()).collect();
            for ns in &self.projection.meta.namespaces { s.insert(ns.clone()); }
            s
        };

        let workspace_id = self.projection.workspace.clone();

        for (raw_key, value) in &self.projection.values {
            let logical = projection_logical_key(raw_key, &explicit_ns);
            let ns = namespace_for_key(&logical);
            self.entries.insert(logical.clone(), RuntimeEntry {
                key: logical.clone(),
                namespace: ns,
                value: Some(value.clone()),
                alias_to: None,
                promoted_from: None,
                formula: None,
                secret_ref: None,
                winner: RuntimeProvenance {
                    source_id: "server-projection".into(),
                    plugin_id: "cnos".into(),
                    workspace_id: workspace_id.clone(),
                },
                formula_cache: FormulaCacheCell::new(),
            });
            self.sources.insert(logical, "server-projection".into());
        }

        let derived_keys: Vec<(String, crate::projection::DerivedFormula)> =
            self.projection.derived.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (raw_key, formula_def) in derived_keys {
            let logical = projection_logical_key(&raw_key, &explicit_ns);
            let ns = namespace_for_key(&logical);
            let parsed = parse_derived_formula(&formula_def)
                .map_err(|e| CnosError::ParseError(format!("parse derived formula for {}: {}", logical, e)))?;
            self.entries.insert(logical.clone(), RuntimeEntry {
                key: logical.clone(),
                namespace: ns,
                value: None,
                alias_to: None,
                promoted_from: None,
                formula: Some(parsed),
                secret_ref: None,
                winner: RuntimeProvenance {
                    source_id: "server-projection".into(),
                    plugin_id: "cnos".into(),
                    workspace_id: workspace_id.clone(),
                },
                formula_cache: FormulaCacheCell::new(),
            });
            self.sources.insert(logical, "server-projection".into());
        }

        let secret_refs: Vec<(String, SecretRefRaw)> =
            self.projection.secret_refs.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (key, mut ref_raw) in secret_refs {
            let logical = to_logical_key("secret", &key);
            if ref_raw.vault.is_empty() { ref_raw.vault = "default".into(); }
            self.logical_key_to_vault.insert(logical.clone(), ref_raw.vault.clone());
            self.entries.insert(logical.clone(), RuntimeEntry {
                key: logical.clone(),
                namespace: "secret".into(),
                value: None,
                alias_to: None,
                promoted_from: None,
                formula: None,
                secret_ref: Some(ref_raw),
                winner: RuntimeProvenance {
                    source_id: "server-projection".into(),
                    plugin_id: "cnos".into(),
                    workspace_id: workspace_id.clone(),
                },
                formula_cache: FormulaCacheCell::new(),
            });
            self.sources.insert(logical, "server-projection".into());
        }

        let public_keys: Vec<String> = self.projection.public_keys.clone();
        for key in public_keys {
            let source_key = if self.entries.contains_key(&key) {
                key.clone()
            } else {
                let fallback = to_logical_key("value", &key);
                if self.entries.contains_key(&fallback) { fallback } else { continue; }
            };
            if source_key.starts_with("secret.") { continue; }
            let public_key = to_logical_key("public", &key);
            self.entries.insert(public_key.clone(), RuntimeEntry {
                key: public_key.clone(),
                namespace: "public".into(),
                value: None,
                alias_to: Some(source_key.clone()),
                promoted_from: Some(source_key),
                formula: None,
                secret_ref: None,
                winner: RuntimeProvenance {
                    source_id: "server-projection".into(),
                    plugin_id: "cnos".into(),
                    workspace_id: workspace_id.clone(),
                },
                formula_cache: FormulaCacheCell::new(),
            });
            self.sources.insert(public_key, "server-projection".into());
        }

        // meta entries
        let profile = self.projection.profile.clone();
        let cnos_version = self.projection.meta.cnos_version.clone();
        self.insert_meta("meta.profile", Value::String(profile), workspace_id.clone());
        self.insert_meta("meta.workspace", Value::String(workspace_id.clone()), workspace_id.clone());
        self.insert_meta("meta.cnos_version", Value::String(cnos_version), workspace_id);
        Ok(())
    }

    fn insert_meta(&mut self, key: &str, value: Value, workspace_id: String) {
        self.entries.insert(key.to_string(), RuntimeEntry {
            key: key.to_string(),
            namespace: "meta".into(),
            value: Some(value),
            alias_to: None,
            promoted_from: None,
            formula: None,
            secret_ref: None,
            winner: RuntimeProvenance { source_id: "server-projection".into(), plugin_id: "cnos".into(), workspace_id },
            formula_cache: FormulaCacheCell::new(),
        });
        self.sources.insert(key.to_string(), "server-projection".into());
    }

    fn initialize_runtime_providers(&mut self) {
        let ns_keys: Vec<String> = self.manifest.runtime_namespaces.keys().cloned().collect();
        self.initialize_runtime_providers_list(&ns_keys);
    }

    fn initialize_runtime_providers_list(&mut self, namespaces: &[String]) {
        for ns in namespaces {
            self.runtime_namespaces.insert(ns.clone());
        }
        if self.runtime_namespaces.contains("process") {
            let env_clone = clone_env_map(&self.env);
            let mut providers = self.runtime_providers.write().unwrap();
            providers.insert("process".into(), Box::new(move |path| process_provider(path, &env_clone)));
        }
    }

    fn prepare_derived_entries(&mut self) -> Result<(), CnosError> {
        let keys: Vec<String> = {
            let mut k: Vec<String> = self.entries.iter()
                .filter(|(_, e)| e.formula.is_some())
                .map(|(k, _)| k.clone())
                .collect();
            k.sort();
            k
        };

        let mut resolved: HashSet<String> = HashSet::new();
        let mut visiting: HashSet<String> = HashSet::new();

        // Collect which keys have formulas and their refs (avoid borrow issues)
        let formula_refs: HashMap<String, Vec<String>> = keys.iter()
            .filter_map(|k| self.entries.get(k).and_then(|e| e.formula.as_ref()).map(|f| (k.clone(), f.refs.clone())))
            .collect();

        let mut runtime_dependent_keys: HashSet<String> = HashSet::new();
        let mut extra_runtime_refs: HashMap<String, Vec<String>> = HashMap::new();

        for key in &keys {
            visit_derived(
                key,
                &formula_refs,
                &self.runtime_namespaces,
                &mut resolved,
                &mut visiting,
                &mut runtime_dependent_keys,
                &mut extra_runtime_refs,
            )?;
        }

        // Apply the computed runtime_dependent flag
        for key in &keys {
            if let Some(entry) = self.entries.get_mut(key) {
                if let Some(formula) = entry.formula.as_mut() {
                    if runtime_dependent_keys.contains(key) {
                        formula.runtime_dependent = true;
                    }
                    if let Some(extra) = extra_runtime_refs.get(key) {
                        let mut rr = formula.runtime_refs.clone();
                        rr.extend_from_slice(extra);
                        formula.runtime_refs = unique_sorted_strings(rr);
                        formula.runtime_dependent = true;
                    }
                    formula.deps = filter_formula_deps(&formula.refs, &self.runtime_namespaces);
                }
            }
        }
        Ok(())
    }

    // ---- read API ----

    pub fn read(&self, key: &str) -> Result<Option<Value>, CnosError> {
        self.read_internal(key, &HashSet::new())
    }

    pub fn require(&self, key: &str) -> Result<Value, CnosError> {
        self.read(key)?.ok_or_else(|| CnosError::MissingKey(key.to_string()))
    }

    pub fn read_or(&self, key: &str, fallback: Option<Value>) -> Result<Option<Value>, CnosError> {
        let v = self.read(key)?;
        Ok(if v.is_none() { fallback } else { v })
    }

    pub fn value(&self, path: &str) -> Result<Option<Value>, CnosError> {
        self.read(&to_logical_key("value", path))
    }

    pub fn secret(&self, path: &str) -> Result<Option<Value>, CnosError> {
        self.read(&to_logical_key("secret", path))
    }

    pub fn meta(&self, path: &str) -> Result<Option<Value>, CnosError> {
        self.read(&to_logical_key("meta", path))
    }

    pub fn public(&self, path: &str) -> Result<Option<Value>, CnosError> {
        self.read(&to_logical_key("public", path))
    }

    pub fn to_object(&self) -> Result<HashMap<String, Value>, CnosError> {
        self.to_namespace_object("")
    }

    pub fn to_namespace(&self, namespace: &str) -> Result<HashMap<String, Value>, CnosError> {
        self.to_namespace_object(namespace.trim())
    }

    pub fn to_public_env(&self, options: ToPublicEnvOptions) -> Result<HashMap<String, String>, CnosError> {
        let prefix = self.resolve_public_prefix(&options)?;
        let mut output = HashMap::new();
        let mut pub_keys: Vec<String> = self.entries.iter()
            .filter(|(_, e)| e.namespace == "public")
            .map(|(k, _)| k.clone())
            .collect();
        pub_keys.sort();

        for key in pub_keys {
            let src = self.entries.get(&key).and_then(|e| e.alias_to.clone()).unwrap_or_else(|| key.clone());
            if src.starts_with("secret.") { continue; }
            let value = self.read(&key)?;
            let value = match value { Some(v) if !v.is_null() => v, _ => continue };
            let base = key.trim_start_matches("public.");
            let base_env_var = fallback_public_env_var(base);
            let env_var = if !prefix.is_empty() && !base_env_var.starts_with(&prefix) {
                format!("{}{}", prefix, base_env_var)
            } else {
                base_env_var
            };
            output.insert(env_var, js_stringify_value(&value));
        }
        Ok(output)
    }

    pub fn format(&self, message: &str) -> Result<String, CnosError> {
        static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let re = RE.get_or_init(|| regex::Regex::new(r"\$\{([^}]+)\}").unwrap());

        let mut error: Option<CnosError> = None;
        let result = re.replace_all(message, |caps: &regex::Captures| {
            if error.is_some() { return caps[0].to_string(); }
            let key = caps[1].trim();
            if key.is_empty() { return caps[0].to_string(); }
            match self.read(key) {
                Err(e) => { error = Some(e); caps[0].to_string() }
                Ok(None) => caps[0].to_string(),
                Ok(Some(v)) => js_log_stringify_value(&v),
            }
        });
        if let Some(e) = error { return Err(e); }
        Ok(result.into_owned())
    }

    pub fn register_runtime_provider<F>(&self, namespace: &str, provider: F) -> Result<(), CnosError>
    where F: Fn(&str) -> Option<Value> + Send + Sync + 'static
    {
        if namespace == "process" {
            return Err(CnosError::RuntimeProviderError(
                format!("cannot override built-in runtime namespace {:?}", namespace)));
        }
        if !self.runtime_namespaces.contains(namespace) {
            return Err(CnosError::RuntimeProviderError(
                format!("cannot register runtime provider for undeclared namespace {:?}", namespace)));
        }
        self.runtime_providers.write().unwrap().insert(namespace.to_string(), Box::new(provider));
        Ok(())
    }

    pub fn register_secret_vault_providers(&self, factories: Vec<SecretVaultProviderFactory>) {
        let mut map = self.secret_factories.lock().unwrap();
        for f in factories {
            if !f.provider.is_empty() {
                map.insert(f.provider.clone(), f);
            }
        }
    }

    pub fn refresh_secrets(&self) -> Result<(), CnosError> {
        let mut hydrated = self.hydrated_secrets.lock().unwrap();
        let mut local_cache = self.local_vault_cache.lock().unwrap();
        hydrated.clear();
        local_cache.clear();
        drop(hydrated);
        drop(local_cache);
        self.warm_secrets()
    }

    pub fn refresh_secret(&self, path: &str) -> Result<(), CnosError> {
        let key = to_logical_key("secret", path);
        {
            let mut hydrated = self.hydrated_secrets.lock().unwrap();
            hydrated.remove(&key);
        }
        if let Some(vault) = self.logical_key_to_vault.get(&key) {
            let mut local_cache = self.local_vault_cache.lock().unwrap();
            local_cache.remove(vault);
        }
        self.read(&key)?;
        Ok(())
    }

    pub fn warm_secrets(&self) -> Result<(), CnosError> {
        let mut secret_keys: Vec<String> = self.entries.iter()
            .filter(|(_, e)| e.secret_ref.is_some())
            .map(|(k, _)| k.clone())
            .collect();
        secret_keys.sort();
        for key in &secret_keys {
            let entry = match self.entries.get(key.as_str()) {
                Some(e) => e,
                None => continue,
            };
            if let Some(ref sr) = entry.secret_ref {
                let sr = sr.clone();
                self.read_secret(key, &sr)?;
            }
        }
        Ok(())
    }

    pub fn projection(&self) -> &ServerProjection {
        &self.projection
    }

    // ---- internal read ----

    fn read_internal(&self, key: &str, stack: &HashSet<String>) -> Result<Option<Value>, CnosError> {
        match self.entries.get(key) {
            None => {
                // Try runtime provider
                if let Some((ns, rest)) = split_logical_key(key) {
                    let providers = self.runtime_providers.read().unwrap();
                    if let Some(provider) = providers.get(ns) {
                        return Ok(provider(rest));
                    }
                }
                Ok(None)
            }
            Some(entry) => {
                if let Some(ref alias) = entry.alias_to.clone() {
                    let alias = alias.clone();
                    return self.read_internal(&alias, stack);
                }
                if let Some(ref sr) = entry.secret_ref.clone() {
                    let sr = sr.clone();
                    return self.read_secret(key, &sr);
                }
                if let Some(ref formula) = entry.formula.clone() {
                    if stack.contains(key) {
                        return Err(CnosError::DerivedError(
                            format!("unable to resolve derived config key {} because of a recursive dependency on {}", key, key)));
                    }
                    // Check cache for config-only formulas
                    if !formula.runtime_dependent && entry.formula_cache.is_cached() {
                        return Ok(entry.formula_cache.get());
                    }
                    let mut next = stack.clone();
                    next.insert(key.to_string());
                    let formula = formula.clone();
                    let this = self as *const CnosRuntime;
                    let result = evaluate_derived_formula(key, &formula, &|ref_key| {
                        // Safety: we hold no mutable references to self here
                        unsafe { &*this }.read_internal(ref_key, &next)
                    })?;
                    if !formula.runtime_dependent {
                        entry.formula_cache.set(result.clone());
                    }
                    return Ok(result);
                }
                Ok(entry.value.clone())
            }
        }
    }

    fn read_secret(&self, key: &str, ref_: &SecretRefRaw) -> Result<Option<Value>, CnosError> {
        // 1. Encrypted secrets (pre-decrypted from env)
        if let Some(v) = self.encrypted_secrets.get(key) {
            return Ok(Some(v.clone()));
        }
        // 2. Cache
        {
            let cache = self.hydrated_secrets.lock().unwrap();
            if cache.contains_key(key) {
                return Ok(cache.get(key).cloned().filter(|v| !v.is_null()));
            }
        }

        let definitions = self.secret_vault_definitions(ref_);
        let mut last_err: Option<CnosError> = None;
        for def in &definitions {
            match self.read_secret_with_definition(key, ref_, def) {
                Err(e) => { last_err = Some(e); continue; }
                Ok(Some(v)) => {
                    let mut cache = self.hydrated_secrets.lock().unwrap();
                    cache.insert(key.to_string(), v.clone());
                    return Ok(Some(v));
                }
                Ok(None) => {}
            }
        }
        if let Some(e) = last_err { return Err(e); }
        {
            let mut cache = self.hydrated_secrets.lock().unwrap();
            cache.insert(key.to_string(), Value::Null);
        }
        Ok(None)
    }

    fn read_secret_with_definition(
        &self,
        key: &str,
        ref_: &SecretRefRaw,
        def: &crate::projection::VaultDef,
    ) -> Result<Option<Value>, CnosError> {
        match def.provider.as_str() {
            "environment" | "github-secrets" => {
                Ok(self.read_env_secret_with_definition(ref_, def))
            }
            "local" => {
                let secrets = self.local_vault_secrets(&ref_.vault, Some(def))?;
                Ok(secrets.get(&ref_.ref_).map(|s| Value::String(s.clone())))
            }
            provider => {
                let factories = self.secret_factories.lock().unwrap();
                if !factories.contains_key(provider) {
                    return Err(CnosError::VaultError(format!("unsupported vault provider: {}", provider)));
                }
                drop(factories);
                self.hydrate_custom_vault(&ref_.vault, def)?;
                let cache = self.hydrated_secrets.lock().unwrap();
                Ok(cache.get(key).cloned().filter(|v| !v.is_null()))
            }
        }
    }

    fn read_env_secret_with_definition(&self, ref_: &SecretRefRaw, def: &crate::projection::VaultDef) -> Option<Value> {
        if let Some(v) = self.env.get(&ref_.ref_).filter(|v| !v.is_empty()) {
            return Some(Value::String(v));
        }
        if !ref_.env_var.is_empty() {
            if let Some(v) = self.env.get(&ref_.env_var).filter(|v| !v.is_empty()) {
                return Some(Value::String(v));
            }
        }
        for (env_var, logical_ref) in &def.mapping {
            if logical_ref == &ref_.ref_ {
                if let Some(v) = self.env.get(env_var).filter(|v| !v.is_empty()) {
                    return Some(Value::String(v));
                }
            }
        }
        None
    }

    fn local_vault_secrets(
        &self,
        vault: &str,
        definition: Option<&crate::projection::VaultDef>,
    ) -> Result<HashMap<String, String>, CnosError> {
        {
            let cache = self.local_vault_cache.lock().unwrap();
            if let Some(secrets) = cache.get(vault) {
                return Ok(secrets.clone());
            }
        }
        let secrets = read_local_vault_secrets(
            &self.secret_home,
            vault,
            definition,
            &self.env,
        )?;
        {
            let mut cache = self.local_vault_cache.lock().unwrap();
            cache.insert(vault.to_string(), secrets.clone());
        }
        Ok(secrets)
    }

    fn secret_vault_definitions(&self, ref_: &SecretRefRaw) -> Vec<crate::projection::VaultDef> {
        let def = self.secret_vault_definition(ref_);
        let mut result = vec![def.clone()];
        result.extend_from_slice(&def.fallback);
        result
    }

    fn secret_vault_definition(&self, ref_: &SecretRefRaw) -> crate::projection::VaultDef {
        if let Some(def) = self.projection.vaults.get(&ref_.vault) {
            let mut d = def.clone();
            if d.provider.is_empty() { d.provider = ref_.provider.clone(); }
            return d;
        }
        let provider = if ref_.provider.is_empty() { "local".to_string() } else { ref_.provider.clone() };
        crate::projection::VaultDef {
            provider: provider.clone(),
            auth: crate::projection::VaultAuth { method: default_vault_method(&provider).into(), ..Default::default() },
            mapping: HashMap::new(),
            fallback: vec![],
        }
    }

    fn hydrate_custom_vault(&self, vault_id: &str, def: &crate::projection::VaultDef) -> Result<(), CnosError> {
        // Collect refs for this vault
        let refs: Vec<(String, String)> = self.entries.iter()
            .filter(|(_, e)| e.secret_ref.as_ref().map(|sr| sr.vault == vault_id).unwrap_or(false))
            .filter(|(k, _)| !self.hydrated_secrets.lock().unwrap().contains_key(k.as_str()))
            .filter_map(|(k, e)| e.secret_ref.as_ref().map(|sr| (k.clone(), sr.ref_.clone())))
            .collect();

        if refs.is_empty() { return Ok(()); }

        let ref_strings: Vec<String> = {
            let mut seen = HashSet::new();
            refs.iter().map(|(_, r)| r.clone()).filter(|r| seen.insert(r.clone())).collect()
        };

        let vault_def = vault_def_for_provider(def);
        let auth = self.resolve_vault_auth(vault_id, def)?;

        let mut factories = self.secret_factories.lock().unwrap();
        let factory = factories.get_mut(&def.provider)
            .ok_or_else(|| CnosError::VaultError(format!("unsupported vault provider: {}", def.provider)))?;

        let mut provider = (factory.create)(vault_id, vault_def)?;
        drop(factories);

        provider.authenticate(auth)?;
        let values = provider.batch_get(&ref_strings)?;

        let mut cache = self.hydrated_secrets.lock().unwrap();
        for (logical_key, ref_str) in &refs {
            if cache.contains_key(logical_key.as_str()) { continue; }
            if let Some(v) = values.get(ref_str) {
                cache.insert(logical_key.clone(), v.clone());
            }
        }
        Ok(())
    }

    fn resolve_vault_auth(
        &self,
        vault_id: &str,
        def: &crate::projection::VaultDef,
    ) -> Result<VaultAuthConfig, CnosError> {
        let method = if def.auth.method.is_empty() {
            default_vault_method(&def.provider).to_string()
        } else {
            def.auth.method.clone()
        };

        let config = def.auth.config.clone();

        match method.as_str() {
            "iam" | "environment" => return Ok(VaultAuthConfig { method, passphrase: String::new(), token: String::new(), config }),
            "token" => {
                if let Some(token_src) = &def.auth.token {
                    for source in &token_src.from {
                        if let Some(t) = self.resolve_vault_source(source) {
                            return Ok(VaultAuthConfig { method: "token".into(), token: t, passphrase: String::new(), config });
                        }
                    }
                }
                return Err(CnosError::VaultError(format!("cannot authenticate to vault {:?}: no token found", vault_id)));
            }
            _ => {}
        }

        if let Some(token_src) = &def.auth.token {
            if !token_src.from.is_empty() {
                for source in &token_src.from {
                    if let Some(t) = self.resolve_vault_source(source) {
                        return Ok(VaultAuthConfig { method: "token".into(), token: t, passphrase: String::new(), config });
                    }
                }
                return Err(CnosError::VaultError(format!("cannot authenticate to vault {:?}: no token found", vault_id)));
            }
        }

        if let Some(pp_src) = &def.auth.passphrase {
            for source in &pp_src.from {
                if let Some(pp) = self.resolve_vault_source(source) {
                    return Ok(VaultAuthConfig { method: "passphrase".into(), passphrase: pp, token: String::new(), config });
                }
            }
        }

        if let Some(pp) = self.resolve_vault_passphrase(vault_id) {
            return Ok(VaultAuthConfig { method: "passphrase".into(), passphrase: pp, token: String::new(), config });
        }

        Ok(VaultAuthConfig { method, passphrase: String::new(), token: String::new(), config })
    }

    fn resolve_vault_source(&self, source: &str) -> Option<String> {
        if let Some(var) = source.strip_prefix("env:") {
            return self.env.get(var.trim()).filter(|v| !v.trim().is_empty());
        }
        if let Some(path) = source.strip_prefix("file:") {
            if let Ok(bytes) = std::fs::read(path.trim()) {
                let s = std::str::from_utf8(&bytes).unwrap_or("").trim().to_string();
                if !s.is_empty() { return Some(s); }
            }
        }
        None
    }

    fn resolve_vault_passphrase(&self, vault: &str) -> Option<String> {
        let var = get_vault_passphrase_env_var(vault);
        self.env.get(&var).filter(|v| !v.is_empty())
            .or_else(|| self.env.get("CNOS_SECRET_PASSPHRASE").filter(|v| !v.is_empty()))
    }

    fn to_namespace_object(&self, namespace: &str) -> Result<HashMap<String, Value>, CnosError> {
        let mut output: HashMap<String, Value> = HashMap::new();
        let mut keys: Vec<String> = self.entries.keys().cloned().collect();
        keys.sort();
        for key in keys {
            let entry = match self.entries.get(&key) { Some(e) => e, None => continue };
            if !namespace.is_empty() && entry.namespace != namespace { continue; }
            let value = match self.read(&key)? { Some(v) => v, None => continue };
            let target = if namespace.is_empty() { key.clone() } else {
                key.trim_start_matches(&format!("{}.", namespace)).to_string()
            };
            set_nested_value(&mut output, &target.split('.').collect::<Vec<_>>(), value);
        }
        Ok(output)
    }

    fn resolve_public_prefix(&self, options: &ToPublicEnvOptions) -> Result<String, CnosError> {
        if let Some(ref p) = options.prefix {
            return Ok(p.clone());
        }
        if let Some(ref fw) = options.framework {
            return self.manifest.frameworks.get(fw)
                .cloned()
                .ok_or_else(|| CnosError::Other(format!("unknown public framework prefix: {}", fw)));
        }
        Ok(String::new())
    }
}

// ---- helpers ----

pub fn to_logical_key(namespace: &str, value_path: &str) -> String {
    let prefix = format!("{}.", namespace);
    if value_path.starts_with(&prefix) { return value_path.to_string(); }
    let parts: Vec<&str> = value_path.split('.').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    format!("{}.{}", namespace, parts.join("."))
}

fn namespace_for_key(key: &str) -> String {
    key.split_once('.').map(|(ns, _)| ns.to_string()).unwrap_or_default()
}

fn split_logical_key(key: &str) -> Option<(&str, &str)> {
    key.split_once('.')
}

fn projection_logical_key(raw: &str, explicit_ns: &HashSet<String>) -> String {
    if raw.starts_with("value.") || raw.starts_with("public.") { return raw.to_string(); }
    let first = raw.split('.').next().unwrap_or("");
    if explicit_ns.contains(first) { return raw.to_string(); }
    to_logical_key("value", raw)
}

fn filter_formula_deps(refs: &[String], runtime_ns: &HashSet<String>) -> Vec<String> {
    let deps: Vec<String> = refs.iter()
        .filter(|r| {
            let ns = r.split_once('.').map(|(n, _)| n).unwrap_or("");
            !ns.is_empty() && !runtime_ns.contains(ns)
        })
        .cloned()
        .collect();
    unique_sorted_strings(deps)
}

fn fallback_public_env_var(value_path: &str) -> String {
    let mut result = String::new();
    let mut last_underscore = false;
    let chars: Vec<char> = value_path.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if c.is_ascii_lowercase() {
            let upper = c.to_ascii_uppercase();
            if i > 0 && !last_underscore {
                let prev = chars[i - 1];
                if prev.is_ascii_lowercase() || prev.is_ascii_digit() {
                    // check if next is uppercase (camelCase boundary)
                    let next_upper = chars.get(i + 1).map(|&nc| nc.is_ascii_uppercase()).unwrap_or(false);
                    if next_upper && !result.ends_with('_') {
                        result.push('_');
                    }
                }
            }
            result.push(upper);
            last_underscore = false;
        } else if c.is_ascii_uppercase() {
            if i > 0 && !last_underscore {
                let prev = chars[i - 1];
                if (prev.is_ascii_lowercase() || prev.is_ascii_digit()) && !result.ends_with('_') {
                    result.push('_');
                }
            }
            result.push(c);
            last_underscore = false;
        } else if c.is_ascii_digit() {
            result.push(c);
            last_underscore = false;
        } else {
            if !last_underscore {
                result.push('_');
                last_underscore = true;
            }
        }
    }
    result.trim_matches('_').to_string()
}

fn set_nested_value(target: &mut HashMap<String, Value>, path: &[&str], value: Value) {
    if path.is_empty() || path[0].is_empty() { return; }
    if path.len() == 1 {
        target.insert(path[0].to_string(), value);
        return;
    }
    let sub = target.entry(path[0].to_string()).or_insert_with(|| Value::Object(serde_json::Map::new()));
    if let Value::Object(map) = sub {
        let mut hm: HashMap<String, Value> = map.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        set_nested_value(&mut hm, &path[1..], value);
        *map = hm.into_iter().collect();
    }
}

fn clone_env_map(_env: &CnosEnvironment) -> HashMap<String, String> {
    std::env::vars().collect()
}

fn process_provider(path: &str, _env: &HashMap<String, String>) -> Option<Value> {
    let parts: Vec<&str> = path.splitn(2, '.').collect();
    if parts.len() > 1 && parts[0] == "env" {
        return std::env::var(parts[1]).ok().map(Value::String);
    }
    match path {
        "cwd" => std::env::current_dir().ok().map(|p| Value::String(p.to_string_lossy().into_owned())),
        "platform" => Some(Value::String(node_platform().to_string())),
        "arch" => Some(Value::String(node_arch().to_string())),
        "pid" => Some(Value::Number(std::process::id().into())),
        _ => None,
    }
}

// Visit function for cycle detection in derived entries
fn visit_derived(
    key: &str,
    formula_refs: &HashMap<String, Vec<String>>,
    runtime_ns: &HashSet<String>,
    resolved: &mut HashSet<String>,
    visiting: &mut HashSet<String>,
    runtime_dependent_keys: &mut HashSet<String>,
    extra_runtime_refs: &mut HashMap<String, Vec<String>>,
) -> Result<(), CnosError> {
    if resolved.contains(key) { return Ok(()); }
    if visiting.contains(key) {
        return Err(CnosError::DerivedError(
            format!("unable to resolve derived config key {} because of a recursive dependency on {}", key, key)));
    }

    let refs = match formula_refs.get(key) {
        None => { resolved.insert(key.to_string()); return Ok(()); }
        Some(r) => r.clone(),
    };

    visiting.insert(key.to_string());
    let mut this_runtime_dependent = false;
    let mut this_extra_refs: Vec<String> = Vec::new();

    for ref_key in &refs {
        let ns = ref_key.split_once('.').map(|(n, _)| n).unwrap_or("");
        if ns.is_empty() { continue; }
        if runtime_ns.contains(ns) {
            this_runtime_dependent = true;
            this_extra_refs.push(ref_key.clone());
            continue;
        }
        if formula_refs.contains_key(ref_key.as_str()) {
            visit_derived(ref_key, formula_refs, runtime_ns, resolved, visiting, runtime_dependent_keys, extra_runtime_refs)?;
            if runtime_dependent_keys.contains(ref_key.as_str()) {
                this_runtime_dependent = true;
            }
        }
    }

    if this_runtime_dependent {
        runtime_dependent_keys.insert(key.to_string());
    }
    if !this_extra_refs.is_empty() {
        extra_runtime_refs.entry(key.to_string()).or_default().extend(this_extra_refs);
    }

    visiting.remove(key);
    resolved.insert(key.to_string());
    Ok(())
}
