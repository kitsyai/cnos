use std::sync::Mutex;
use cnos::{CnosRuntime, Options, reset_default_runtime, set_default_runtime};
use serde_json::Value;

// Serialize all singleton tests — global state is process-wide.
static TEST_LOCK: Mutex<()> = Mutex::new(());

fn minimal_projection() -> &'static str {
    r#"{
      "version": 1,
      "workspace": "base",
      "profile": "local",
      "resolvedAt": "2024-01-01T00:00:00Z",
      "configHash": "abc123",
      "values": {
        "server.port": 3000,
        "app.name": "cnos-rust"
      },
      "derived": {
        "app.effectiveHost": {
          "expr": "coalesce(request.headers.host, 'default.host')",
          "deps": [],
          "runtimeRefs": ["request.headers.host"]
        }
      },
      "secretRefs": {},
      "publicKeys": ["app.name"],
      "runtimeNamespaces": ["request"],
      "meta": {
        "workspace": "base",
        "profile": "local",
        "cnos_version": "1.14.0"
      }
    }"#
}

fn make_runtime() -> CnosRuntime {
    CnosRuntime::load_projection(minimal_projection().as_bytes(), Options::default()).unwrap()
}

#[test]
fn read_before_init_returns_error() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_default_runtime();
    let err = cnos::read("value.server.port").unwrap_err();
    assert!(err.to_string().contains("not initialized"));
}

#[test]
fn set_runtime_makes_read_work() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_default_runtime();
    set_default_runtime(make_runtime());

    let v = cnos::value("server.port").unwrap().unwrap();
    assert_eq!(v.as_i64().unwrap(), 3000);
}

#[test]
fn require_returns_value() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_default_runtime();
    set_default_runtime(make_runtime());

    let v = cnos::require("value.app.name").unwrap();
    assert_eq!(v.as_str().unwrap(), "cnos-rust");
}

#[test]
fn read_or_returns_fallback_for_missing_key() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_default_runtime();
    set_default_runtime(make_runtime());

    let v = cnos::read_or("value.nonexistent", Some(Value::String("fallback".into()))).unwrap();
    assert_eq!(v.unwrap().as_str().unwrap(), "fallback");
}

#[test]
fn ready_is_idempotent_after_set() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_default_runtime();
    set_default_runtime(make_runtime());
    let first = cnos::default_runtime().unwrap();

    // ready() on an already-initialized singleton keeps the same instance
    let _ = cnos::ready(Options::default()); // may fail to find projection — that's fine
    let second = cnos::default_runtime().unwrap();

    // Same Arc pointer — identity preserved
    assert!(std::sync::Arc::ptr_eq(&first, &second));
}

#[test]
fn reset_clears_runtime() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_default_runtime();
    set_default_runtime(make_runtime());
    reset_default_runtime();

    let err = cnos::read("value.server.port").unwrap_err();
    assert!(err.to_string().contains("not initialized"));
}

#[test]
fn to_public_env_includes_promoted_keys() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_default_runtime();
    set_default_runtime(make_runtime());

    let env = cnos::to_public_env(cnos::ToPublicEnvOptions {
        framework: Some("vite".to_string()),
        prefix: None,
    }).unwrap();
    assert_eq!(env.get("VITE_APP_NAME").map(String::as_str), Some("cnos-rust"));
}

#[test]
fn format_substitutes_config_keys() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_default_runtime();
    set_default_runtime(make_runtime());

    let msg = cnos::format("App: ${value.app.name}").unwrap();
    assert_eq!(msg, "App: cnos-rust");
}

// ============================================================
// Composition model tests
// ============================================================
//
// Simulates: root → lib_a → lib_b → lib_c → lib_d, lib_e → lib_f
// Libraries call the module-level singleton. Only the root initializes.

fn lib_f_read_meta() -> Result<Option<Value>, cnos::CnosError> {
    cnos::meta("workspace")
}

fn lib_e_read_meta() -> Result<Option<Value>, cnos::CnosError> {
    lib_f_read_meta()
}

fn lib_d_read_port() -> Result<Option<Value>, cnos::CnosError> {
    cnos::value("server.port")
}

fn lib_c_read_port() -> Result<Option<Value>, cnos::CnosError> {
    lib_d_read_port()
}

fn lib_b_read() -> Result<(Option<Value>, Option<Value>), cnos::CnosError> {
    Ok((lib_c_read_port()?, lib_e_read_meta()?))
}

fn lib_a_read() -> Result<(Option<Value>, Option<Value>), cnos::CnosError> {
    lib_b_read()
}

#[test]
fn composition_libraries_succeed_after_root_initializes() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_default_runtime();
    set_default_runtime(make_runtime());  // root initializes once

    let (port, workspace) = lib_a_read().unwrap();
    assert_eq!(port.unwrap().as_i64().unwrap(), 3000);
    assert_eq!(workspace.unwrap().as_str().unwrap(), "base");
}

#[test]
fn composition_libraries_fail_before_root_initializes() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_default_runtime();

    let result = lib_a_read();
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("not initialized"));
}

#[test]
fn composition_multiple_libraries_share_same_runtime() {
    let _guard = TEST_LOCK.lock().unwrap();
    reset_default_runtime();
    set_default_runtime(make_runtime());

    let first = cnos::default_runtime().unwrap();
    let _ = lib_a_read().unwrap();
    let second = cnos::default_runtime().unwrap();
    assert!(std::sync::Arc::ptr_eq(&first, &second));
}
