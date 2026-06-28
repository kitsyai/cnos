use cnos::{CnosRuntime, Options};
use serde_json::Value;

fn load(json: &str) -> CnosRuntime {
    CnosRuntime::load_projection(json.as_bytes(), Options::default()).unwrap()
}

#[test]
fn template_interpolation() {
    let rt = load(r#"{
      "version":1,"workspace":"base","profile":"local",
      "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
      "values":{"server.host":"localhost","server.port":8080},
      "derived":{"value.url":{"expr":"${value.server.host}:${value.server.port}","deps":["value.server.host","value.server.port"],"runtimeRefs":[]}},
      "secretRefs":{},"publicKeys":[],"runtimeNamespaces":[],
      "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4"}
    }"#);
    let v = rt.value("url").unwrap().unwrap();
    assert_eq!(v.as_str().unwrap(), "localhost:8080");
}

#[test]
fn coalesce_returns_first_non_null() {
    let rt = load(r#"{
      "version":1,"workspace":"base","profile":"local",
      "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
      "values":{"x":"hello"},
      "derived":{"value.result":{"expr":"coalesce(value.missing, value.x)","deps":["value.x"],"runtimeRefs":[]}},
      "secretRefs":{},"publicKeys":[],"runtimeNamespaces":[],
      "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4"}
    }"#);
    let v = rt.value("result").unwrap().unwrap();
    assert_eq!(v.as_str().unwrap(), "hello");
}

#[test]
fn when_true_returns_first_branch() {
    let rt = load(r#"{
      "version":1,"workspace":"base","profile":"local",
      "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
      "values":{"flag":true},
      "derived":{"value.result":{"expr":"when(value.flag, 'yes', 'no')","deps":["value.flag"],"runtimeRefs":[]}},
      "secretRefs":{},"publicKeys":[],"runtimeNamespaces":[],
      "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4"}
    }"#);
    let v = rt.value("result").unwrap().unwrap();
    assert_eq!(v.as_str().unwrap(), "yes");
}

#[test]
fn when_false_returns_second_branch() {
    let rt = load(r#"{
      "version":1,"workspace":"base","profile":"local",
      "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
      "values":{"flag":false},
      "derived":{"value.result":{"expr":"when(value.flag, 'yes', 'no')","deps":["value.flag"],"runtimeRefs":[]}},
      "secretRefs":{},"publicKeys":[],"runtimeNamespaces":[],
      "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4"}
    }"#);
    let v = rt.value("result").unwrap().unwrap();
    assert_eq!(v.as_str().unwrap(), "no");
}

#[test]
fn exists_returns_true_for_present_key() {
    let rt = load(r#"{
      "version":1,"workspace":"base","profile":"local",
      "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
      "values":{"x":"hello"},
      "derived":{"value.result":{"expr":"exists(value.x)","deps":["value.x"],"runtimeRefs":[]}},
      "secretRefs":{},"publicKeys":[],"runtimeNamespaces":[],
      "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4"}
    }"#);
    let v = rt.value("result").unwrap().unwrap();
    assert_eq!(v.as_bool().unwrap(), true);
}

#[test]
fn eq_returns_true_for_equal_strings() {
    let rt = load(r#"{
      "version":1,"workspace":"base","profile":"local",
      "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
      "values":{"env":"prod"},
      "derived":{"value.result":{"expr":"eq(value.env, 'prod')","deps":["value.env"],"runtimeRefs":[]}},
      "secretRefs":{},"publicKeys":[],"runtimeNamespaces":[],
      "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4"}
    }"#);
    let v = rt.value("result").unwrap().unwrap();
    assert_eq!(v.as_bool().unwrap(), true);
}

#[test]
fn config_only_derived_value_is_cached() {
    let rt = load(r#"{
      "version":1,"workspace":"base","profile":"local",
      "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
      "values":{"base":"hello"},
      "derived":{"value.result":{"expr":"${value.base}","deps":["value.base"],"runtimeRefs":[]}},
      "secretRefs":{},"publicKeys":[],"runtimeNamespaces":[],
      "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4"}
    }"#);
    let v1 = rt.value("result").unwrap();
    let v2 = rt.value("result").unwrap();
    assert_eq!(v1, v2);
}

#[test]
fn literal_string_in_expression() {
    let rt = load(r#"{
      "version":1,"workspace":"base","profile":"local",
      "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
      "values":{},
      "derived":{"value.result":{"expr":"'static-value'","deps":[],"runtimeRefs":[]}},
      "secretRefs":{},"publicKeys":[],"runtimeNamespaces":[],
      "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4"}
    }"#);
    let v = rt.value("result").unwrap().unwrap();
    assert_eq!(v.as_str().unwrap(), "static-value");
}

#[test]
fn literal_number_in_expression() {
    let rt = load(r#"{
      "version":1,"workspace":"base","profile":"local",
      "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
      "values":{},
      "derived":{"value.result":{"expr":"42","deps":[],"runtimeRefs":[]}},
      "secretRefs":{},"publicKeys":[],"runtimeNamespaces":[],
      "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4"}
    }"#);
    let v = rt.value("result").unwrap().unwrap();
    assert!((v.as_f64().unwrap() - 42.0).abs() < f64::EPSILON);
}

#[test]
fn ne_expression() {
    let rt = load(r#"{
      "version":1,"workspace":"base","profile":"local",
      "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
      "values":{"env":"dev"},
      "derived":{"value.result":{"expr":"ne(value.env, 'prod')","deps":["value.env"],"runtimeRefs":[]}},
      "secretRefs":{},"publicKeys":[],"runtimeNamespaces":[],
      "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4"}
    }"#);
    let v = rt.value("result").unwrap().unwrap();
    assert_eq!(v.as_bool().unwrap(), true);
}

#[test]
fn literal_bool_true() {
    let rt = load(r#"{
      "version":1,"workspace":"base","profile":"local",
      "resolvedAt":"2024-01-01T00:00:00Z","configHash":"h",
      "values":{},
      "derived":{"value.result":{"expr":"true","deps":[],"runtimeRefs":[]}},
      "secretRefs":{},"publicKeys":[],"runtimeNamespaces":[],
      "meta":{"workspace":"base","profile":"local","cnos_version":"1.11.4"}
    }"#);
    let v = rt.value("result").unwrap().unwrap();
    assert_eq!(v.as_bool().unwrap(), true);
}
