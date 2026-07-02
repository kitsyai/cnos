use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::error::CnosError;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OverrideSpec {
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub arg: Vec<String>,
    #[serde(default)]
    pub priority: Vec<String>,
    #[serde(rename = "type", default)]
    pub value_type: String,
}

pub const PROJECTION_ENV_VAR: &str = "__CNOS_PROJECTION__";
pub const SECRET_PAYLOAD_ENV_VAR: &str = "__CNOS_SECRET_PAYLOAD__";
pub const SESSION_KEY_ENV_VAR: &str = "__CNOS_SESSION_KEY__";
pub const GRAPH_ENV_VAR: &str = "__CNOS_GRAPH__";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DerivedFormula {
    pub expr: String,
    #[serde(default)]
    pub deps: Vec<String>,
    #[serde(rename = "runtimeRefs", default)]
    pub runtime_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretReference {
    #[serde(default)]
    pub provider: String,
    pub ref_: String,
    #[serde(default)]
    pub vault: String,
    #[serde(rename = "envVar", default)]
    pub env_var: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectionMeta {
    pub workspace: String,
    pub profile: String,
    pub cnos_version: String,
    #[serde(default)]
    pub namespaces: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultAuthSource {
    #[serde(default)]
    pub from: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VaultAuth {
    #[serde(default)]
    pub method: String,
    pub passphrase: Option<VaultAuthSource>,
    pub token: Option<VaultAuthSource>,
    #[serde(default)]
    pub config: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultDef {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub auth: VaultAuth,
    #[serde(default)]
    pub mapping: HashMap<String, String>,
    #[serde(default)]
    pub fallback: Vec<VaultDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerProjection {
    pub version: i64,
    pub workspace: String,
    pub profile: String,
    #[serde(rename = "resolvedAt")]
    pub resolved_at: String,
    #[serde(rename = "configHash")]
    pub config_hash: String,
    #[serde(default)]
    pub values: HashMap<String, Value>,
    #[serde(default)]
    pub derived: HashMap<String, DerivedFormula>,
    #[serde(rename = "secretRefs", default)]
    pub secret_refs: HashMap<String, SecretRefRaw>,
    #[serde(default)]
    pub vaults: HashMap<String, VaultDef>,
    #[serde(rename = "publicKeys", default)]
    pub public_keys: Vec<String>,
    #[serde(rename = "runtimeNamespaces", default)]
    pub runtime_namespaces: Vec<String>,
    #[serde(rename = "valueTypes", default)]
    pub value_types: HashMap<String, String>,
    #[serde(default)]
    pub overrides: HashMap<String, OverrideSpec>,
    pub meta: ProjectionMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretRefRaw {
    #[serde(default)]
    pub provider: String,
    #[serde(rename = "ref")]
    pub ref_: String,
    #[serde(default)]
    pub vault: String,
    #[serde(rename = "envVar", default)]
    pub env_var: String,
}

pub fn parse_projection(data: &[u8]) -> Result<ServerProjection, CnosError> {
    let mut proj: ServerProjection = serde_json::from_slice(data)
        .map_err(|e| CnosError::ParseError(format!("parse server projection: {}", e)))?;

    if proj.version != 1
        || proj.workspace.is_empty()
        || proj.profile.is_empty()
        || proj.resolved_at.is_empty()
        || proj.config_hash.is_empty()
        || proj.meta.workspace.is_empty()
        || proj.meta.profile.is_empty()
        || proj.meta.cnos_version.is_empty()
    {
        return Err(CnosError::InvalidProjection("invalid server projection payload".into()));
    }

    // Normalize secret refs: fill in default vault/provider
    let secret_refs: Vec<(String, SecretRefRaw)> = proj.secret_refs.drain().collect();
    for (key, mut r) in secret_refs {
        if r.vault.is_empty() {
            r.vault = "default".into();
        }
        if r.provider.is_empty() {
            if let Some(vault_def) = proj.vaults.get(&r.vault) {
                if !vault_def.provider.is_empty() {
                    r.provider = vault_def.provider.clone();
                } else {
                    r.provider = "local".into();
                }
            } else {
                r.provider = "local".into();
            }
        }
        proj.secret_refs.insert(key, r);
    }

    Ok(proj)
}
