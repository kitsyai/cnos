use std::collections::HashMap;
use serde::Deserialize;
use serde_json::Value;
use crate::derive::{is_derived_value, parse_raw_derived_value};
use crate::error::CnosError;
use crate::manifest::{BootstrappedManifest, RuntimeNamespaceDef, default_frameworks, default_namespace_defs};
use crate::runtime::{RuntimeEntry, RuntimeProvenance};

#[derive(Debug, Deserialize)]
pub struct RuntimeGraph {
    pub entries: Vec<GraphResolvedEntry>,
    pub profile: String,
    #[serde(rename = "resolvedAt")]
    pub resolved_at: String,
    #[serde(rename = "profileSource")]
    pub profile_source: String,
    pub workspace: GraphWorkspace,
}

#[derive(Debug, Deserialize)]
pub struct GraphResolvedEntry {
    pub key: String,
    pub value: Option<Value>,
    pub namespace: String,
    pub winner: GraphConfigEntry,
    #[serde(default)]
    pub overridden: Vec<GraphConfigEntry>,
}

#[derive(Debug, Deserialize)]
pub struct GraphConfigEntry {
    pub key: String,
    pub value: Option<Value>,
    pub namespace: String,
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "pluginId")]
    pub plugin_id: String,
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
pub struct GraphWorkspace {
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[serde(rename = "workspaceSource")]
    pub workspace_source: String,
    #[serde(rename = "workspaceChain")]
    pub workspace_chain: Vec<String>,
}

pub fn parse_runtime_graph(data: &[u8]) -> Result<RuntimeGraph, CnosError> {
    let graph: RuntimeGraph = serde_json::from_slice(data)
        .map_err(|e| CnosError::ParseError(format!("parse runtime graph: {}", e)))?;

    if graph.profile.is_empty()
        || graph.resolved_at.is_empty()
        || graph.profile_source.is_empty()
        || graph.workspace.workspace_id.is_empty()
        || graph.workspace.workspace_source.is_empty()
    {
        return Err(CnosError::InvalidProjection("invalid runtime graph payload".into()));
    }

    for entry in &graph.entries {
        if entry.key.is_empty() || entry.namespace.is_empty()
            || entry.winner.source_id.is_empty()
            || entry.winner.plugin_id.is_empty()
            || entry.winner.workspace_id.is_empty()
        {
            return Err(CnosError::InvalidProjection("invalid runtime graph payload".into()));
        }
    }

    Ok(graph)
}

pub fn runtime_entry_from_graph(resolved: GraphResolvedEntry) -> Result<RuntimeEntry, CnosError> {
    use crate::runtime::RuntimeEntry;
    let promoted_from = resolved.winner.metadata.get("promotedFrom")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let winner = RuntimeProvenance {
        source_id: resolved.winner.source_id.clone(),
        plugin_id: resolved.winner.plugin_id.clone(),
        workspace_id: resolved.winner.workspace_id.clone(),
    };

    if resolved.namespace == "secret" {
        if let Some(ref val) = resolved.value {
            if is_secret_reference_value(val) {
                let sr = to_secret_reference(val)?;
                return Ok(RuntimeEntry {
                    key: resolved.key,
                    namespace: resolved.namespace,
                    value: None,
                    alias_to: None,
                    promoted_from,
                    formula: None,
                    secret_ref: Some(sr),
                    winner,
                    formula_cache: crate::runtime::FormulaCacheCell::new(),
                });
            }
        }
    }

    if let Some(ref val) = resolved.value {
        if is_derived_value(val) {
            let parsed = parse_raw_derived_value(val)
                .map_err(|e| CnosError::ParseError(format!("parse derived formula for {}: {}", resolved.key, e)))?;
            return Ok(RuntimeEntry {
                key: resolved.key,
                namespace: resolved.namespace,
                value: None,
                alias_to: None,
                promoted_from,
                formula: Some(parsed),
                secret_ref: None,
                winner,
                formula_cache: crate::runtime::FormulaCacheCell::new(),
            });
        }
    }

    Ok(RuntimeEntry {
        key: resolved.key,
        namespace: resolved.namespace,
        value: resolved.value,
        alias_to: None,
        promoted_from,
        formula: None,
        secret_ref: None,
        winner,
        formula_cache: crate::runtime::FormulaCacheCell::new(),
    })
}

fn is_secret_reference_value(val: &Value) -> bool {
    let obj = match val.as_object() { Some(o) => o, None => return false };
    let ref_ = match obj.get("ref").and_then(|v| v.as_str()) { Some(s) => s, None => return false };
    if ref_.trim().is_empty() { return false; }
    if let Some(provider) = obj.get("provider").and_then(|v| v.as_str()) {
        if provider.trim().is_empty() { return false; }
    }
    obj.keys().all(|k| k == "provider" || k == "ref" || k == "vault")
}

fn to_secret_reference(val: &Value) -> Result<crate::projection::SecretRefRaw, CnosError> {
    let obj = val.as_object().ok_or_else(|| CnosError::ParseError("invalid secret reference".into()))?;
    let ref_ = obj.get("ref").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if ref_.is_empty() {
        return Err(CnosError::ParseError("invalid secret reference".into()));
    }
    Ok(crate::projection::SecretRefRaw {
        provider: obj.get("provider").and_then(|v| v.as_str()).unwrap_or("").trim().to_string(),
        ref_,
        vault: obj.get("vault").and_then(|v| v.as_str()).unwrap_or("").trim().to_string(),
        env_var: String::new(),
    })
}

pub fn bootstrapped_manifest_from_graph(graph: &RuntimeGraph) -> BootstrappedManifest {
    let namespaces = default_namespace_defs();
    let mut runtime_namespaces: HashMap<String, RuntimeNamespaceDef> = HashMap::new();
    runtime_namespaces.insert("process".into(), RuntimeNamespaceDef { server_only: true, built_in: true });

    // Discover runtime namespaces from derived entries
    let config_ns: std::collections::HashSet<&str> = ["value", "secret", "meta", "public"].iter().copied().collect();
    for entry in &graph.entries {
        if let Some(ref val) = entry.value {
            if is_derived_value(val) {
                if let Ok(parsed) = parse_raw_derived_value(val) {
                    for ref_ in &parsed.refs {
                        let ns = ref_.split_once('.').map(|(n, _)| n).unwrap_or("");
                        if !ns.is_empty() && !config_ns.contains(ns) && ns != "process" {
                            runtime_namespaces.entry(ns.to_string()).or_insert(RuntimeNamespaceDef { server_only: true, built_in: false });
                        }
                    }
                }
            }
        }
    }

    BootstrappedManifest {
        namespaces,
        runtime_namespaces,
        frameworks: default_frameworks(),
        vaults: HashMap::new(),
    }
}
