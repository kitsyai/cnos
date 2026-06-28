use std::collections::HashMap;
use cnos::{CnosError, CnosRuntime, Options};
use serde_json::{json, Value};

fn minimal_projection() -> &'static str {
    r#"{
      "version": 1,
      "workspace": "base",
      "profile": "local",
      "resolvedAt": "2024-01-01T00:00:00Z",
      "configHash": "abc123",
      "values": {
        "server.port": 3000,
        "server.host": "localhost",
        "featureFlag": true,
        "app.name": "my-app"
      },
      "derived": {
        "server.url": {
          "expr": "${value.server.host}:${value.server.port}",
          "deps": ["value.server.host", "value.server.port"],
          "runtimeRefs": []
        }
      },
      "secretRefs": {
        "db.password": { "provider": "environment", "ref": "DB_PASSWORD", "vault": "default" }
      },
      "publicKeys": ["server.port"],
      "runtimeNamespaces": [],
      "meta": {
        "workspace": "base",
        "profile": "local",
        "cnos_version": "1.11.4"
      }
    }"#
}

fn make_runtime() -> CnosRuntime {
    let mut env = HashMap::new();
    env.insert("DB_PASSWORD".to_string(), "s3cr3t".to_string());
    CnosRuntime::load_projection(
        minimal_projection().as_bytes(),
        Options { environment: Some(env), ..Default::default() },
    ).unwrap()
}

#[test]
fn load_from_projection_bytes() {
    let rt = make_runtime();
    // just verifying it loaded — no panic
    let _ = rt.projection();
}

#[test]
fn read_value_key() {
    let rt = make_runtime();
    let v = rt.value("server.port").unwrap().unwrap();
    assert_eq!(v.as_i64().unwrap(), 3000);
}

#[test]
fn read_string_value() {
    let rt = make_runtime();
    let v = rt.value("server.host").unwrap().unwrap();
    assert_eq!(v.as_str().unwrap(), "localhost");
}

#[test]
fn read_boolean_value() {
    let rt = make_runtime();
    let v = rt.value("featureFlag").unwrap().unwrap();
    assert_eq!(v.as_bool().unwrap(), true);
}

#[test]
fn read_absent_key_returns_none() {
    let rt = make_runtime();
    let v = rt.read("value.nonexistent").unwrap();
    assert!(v.is_none());
}

#[test]
fn require_absent_key_throws() {
    let rt = make_runtime();
    let err = rt.require("value.nonexistent").unwrap_err();
    assert!(matches!(err, CnosError::MissingKey(_)));
}

#[test]
fn read_derived_template_formula() {
    let rt = make_runtime();
    let v = rt.value("server.url").unwrap().unwrap();
    assert_eq!(v.as_str().unwrap(), "localhost:3000");
}

#[test]
fn read_meta_profile() {
    let rt = make_runtime();
    let v = rt.meta("profile").unwrap().unwrap();
    assert_eq!(v.as_str().unwrap(), "local");
}

#[test]
fn read_meta_workspace() {
    let rt = make_runtime();
    let v = rt.meta("workspace").unwrap().unwrap();
    assert_eq!(v.as_str().unwrap(), "base");
}

#[test]
fn read_meta_cnos_version() {
    let rt = make_runtime();
    let v = rt.meta("cnos_version").unwrap().unwrap();
    assert_eq!(v.as_str().unwrap(), "1.11.4");
}

#[test]
fn read_or_returns_fallback_when_absent() {
    let rt = make_runtime();
    let v = rt.read_or("value.missing", Some(Value::String("fallback".into()))).unwrap();
    assert_eq!(v.unwrap().as_str().unwrap(), "fallback");
}

#[test]
fn read_or_returns_value_when_present() {
    let rt = make_runtime();
    let v = rt.read_or("value.server.host", Some(Value::String("fallback".into()))).unwrap();
    assert_eq!(v.unwrap().as_str().unwrap(), "localhost");
}

#[test]
fn read_secret_from_environment() {
    let rt = make_runtime();
    let v = rt.secret("db.password").unwrap().unwrap();
    assert_eq!(v.as_str().unwrap(), "s3cr3t");
}

#[test]
fn read_public_key() {
    let rt = make_runtime();
    let v = rt.public("server.port").unwrap().unwrap();
    assert_eq!(v.as_i64().unwrap(), 3000);
}

#[test]
fn to_logical_key_is_idempotent() {
    let rt = make_runtime();
    let v1 = rt.value("server.host").unwrap();
    let v2 = rt.value("value.server.host").unwrap();
    assert_eq!(v1, v2);
}

#[test]
fn invalid_projection_returns_error() {
    let result = CnosRuntime::load_projection(b"{}", Options::default());
    assert!(result.is_err());
}

#[test]
fn missing_projection_returns_error() {
    let result = CnosRuntime::load(Options {
        working_dir: Some("/no-such-dir-cnos-test".into()),
        ..Default::default()
    });
    assert!(result.is_err());
}

#[test]
fn format_interpolates_keys() {
    let rt = make_runtime();
    let result = rt.format("host=${value.server.host} port=${value.server.port}").unwrap();
    assert_eq!(result, "host=localhost port=3000");
}

#[test]
fn to_public_env_contains_promoted_keys() {
    let rt = make_runtime();
    let env = rt.to_public_env(cnos::ToPublicEnvOptions::default()).unwrap();
    assert!(env.contains_key("SERVER_PORT"));
    assert_eq!(env["SERVER_PORT"], "3000");
}

#[test]
fn to_public_env_applies_framework_prefix() {
    let rt = make_runtime();
    let env = rt.to_public_env(cnos::ToPublicEnvOptions {
        framework: Some("next".into()),
        prefix: None,
    }).unwrap();
    assert!(env.contains_key("NEXT_PUBLIC_SERVER_PORT"));
}

#[test]
fn register_and_call_runtime_provider() {
    let projection = r#"{
      "version":1,"workspace":"base","profile":"local",
      "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
      "values":{},
      "derived":{"request.result":{"expr":"${request.user}","deps":[],"runtimeRefs":["request.user"]}},
      "secretRefs":{},"publicKeys":[],
      "runtimeNamespaces":["request"],
      "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4","namespaces":["request"]}
    }"#;
    let rt = CnosRuntime::load_projection(projection.as_bytes(), Options::default()).unwrap();
    rt.register_runtime_provider("request", |path| {
        if path == "user" { Some(Value::String("alice".into())) } else { None }
    }).unwrap();

    let v = rt.read("request.user").unwrap().unwrap();
    assert_eq!(v.as_str().unwrap(), "alice");
}

#[test]
fn register_runtime_provider_for_process_fails() {
    let rt = make_runtime();
    let err = rt.register_runtime_provider("process", |_| None).unwrap_err();
    assert!(matches!(err, CnosError::RuntimeProviderError(_)));
}

#[test]
fn derived_cyclic_reference_returns_error() {
    let projection = r#"{
      "version":1,"workspace":"base","profile":"local",
      "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
      "values":{},
      "derived":{
        "value.a":{"expr":"${value.b}","deps":["value.b"],"runtimeRefs":[]},
        "value.b":{"expr":"${value.a}","deps":["value.a"],"runtimeRefs":[]}
      },
      "secretRefs":{},"publicKeys":[],"runtimeNamespaces":[],
      "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4"}
    }"#;
    let result = CnosRuntime::load_projection(projection.as_bytes(), Options::default());
    assert!(result.is_err());
}
