use std::sync::{Arc, Mutex, OnceLock};
use crate::error::CnosError;
use crate::runtime::{CnosRuntime, Options, ToPublicEnvOptions};
use serde_json::Value;
use std::collections::HashMap;

static RUNTIME_STORAGE: OnceLock<Mutex<Option<Arc<CnosRuntime>>>> = OnceLock::new();

fn storage() -> &'static Mutex<Option<Arc<CnosRuntime>>> {
    RUNTIME_STORAGE.get_or_init(|| {
        let initial = bootstrap_default_runtime().map(Arc::new).ok();
        Mutex::new(initial)
    })
}

fn bootstrap_default_runtime() -> Result<CnosRuntime, CnosError> {
    CnosRuntime::load(Options::default())
}

pub fn set_default_runtime(runtime: CnosRuntime) {
    *storage().lock().unwrap() = Some(Arc::new(runtime));
}

pub fn default_runtime() -> Result<Arc<CnosRuntime>, CnosError> {
    storage().lock().unwrap().clone()
        .ok_or_else(|| CnosError::Other("cnos: runtime not initialized. Call ready() or load a runtime".into()))
}

pub fn reset_default_runtime() {
    *storage().lock().unwrap() = None;
}

pub fn ready(options: Options) -> Result<(), CnosError> {
    // First check under lock — fast path when already initialized.
    let existing = { storage().lock().unwrap().clone() };
    if let Some(rt) = existing {
        if !options.secret_vault_providers.is_empty() {
            rt.register_secret_vault_providers(options.secret_vault_providers);
        }
        return rt.warm_secrets();
    }

    // Load without holding the lock (slow I/O).
    let loaded = CnosRuntime::load(options)?;
    loaded.warm_secrets()?;

    // Re-acquire and set only if still uninitialized — prevents double-init races.
    let mut guard = storage().lock().unwrap();
    if guard.is_none() {
        *guard = Some(Arc::new(loaded));
    }
    Ok(())
}

pub fn read(key: &str) -> Result<Option<Value>, CnosError> {
    default_runtime()?.read(key)
}

pub fn require(key: &str) -> Result<Value, CnosError> {
    default_runtime()?.require(key)
}

pub fn read_or(key: &str, fallback: Option<Value>) -> Result<Option<Value>, CnosError> {
    default_runtime()?.read_or(key, fallback)
}

pub fn value(path: &str) -> Result<Option<Value>, CnosError> {
    default_runtime()?.value(path)
}

pub fn secret(path: &str) -> Result<Option<Value>, CnosError> {
    default_runtime()?.secret(path)
}

pub fn meta(path: &str) -> Result<Option<Value>, CnosError> {
    default_runtime()?.meta(path)
}

pub fn public(path: &str) -> Result<Option<Value>, CnosError> {
    default_runtime()?.public(path)
}

pub fn to_object() -> Result<HashMap<String, Value>, CnosError> {
    default_runtime()?.to_object()
}

pub fn to_public_env(options: ToPublicEnvOptions) -> Result<HashMap<String, String>, CnosError> {
    default_runtime()?.to_public_env(options)
}

pub fn format(message: &str) -> Result<String, CnosError> {
    default_runtime()?.format(message)
}

pub fn refresh_secrets() -> Result<(), CnosError> {
    default_runtime()?.refresh_secrets()
}

pub fn refresh_secret(path: &str) -> Result<(), CnosError> {
    default_runtime()?.refresh_secret(path)
}
