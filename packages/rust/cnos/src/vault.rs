use std::collections::HashMap;
use serde_json::Value;
use crate::error::CnosError;
use crate::projection::VaultDef;

#[derive(Debug, Clone)]
pub struct VaultAuthSource {
    pub from: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct VaultAuthDefinition {
    pub method: String,
    pub passphrase: Option<VaultAuthSource>,
    pub token: Option<VaultAuthSource>,
    pub config: HashMap<String, Value>,
}

#[derive(Debug, Clone)]
pub struct VaultDefinition {
    pub provider: String,
    pub auth: VaultAuthDefinition,
    pub mapping: HashMap<String, String>,
    pub fallback: Vec<VaultDefinition>,
}

#[derive(Debug, Clone)]
pub struct VaultAuthConfig {
    pub method: String,
    pub passphrase: String,
    pub token: String,
    pub config: HashMap<String, Value>,
}

pub trait SecretVaultProvider: Send + Sync {
    fn authenticate(&mut self, auth: VaultAuthConfig) -> Result<(), CnosError>;
    fn batch_get(&self, refs: &[String]) -> Result<HashMap<String, Value>, CnosError>;
    fn get(&self, reference: &str) -> Result<Option<Value>, CnosError>;
}

pub struct SecretVaultProviderFactory {
    pub provider: String,
    pub create: Box<dyn Fn(&str, VaultDefinition) -> Result<Box<dyn SecretVaultProvider>, CnosError> + Send + Sync>,
}

impl SecretVaultProviderFactory {
    pub fn new<F>(provider: impl Into<String>, create: F) -> Self
    where
        F: Fn(&str, VaultDefinition) -> Result<Box<dyn SecretVaultProvider>, CnosError> + Send + Sync + 'static,
    {
        SecretVaultProviderFactory { provider: provider.into(), create: Box::new(create) }
    }
}

pub fn vault_def_for_provider(def: &VaultDef) -> VaultDefinition {
    VaultDefinition {
        provider: def.provider.clone(),
        auth: VaultAuthDefinition {
            method: def.auth.method.clone(),
            passphrase: def.auth.passphrase.as_ref().map(|s| VaultAuthSource { from: s.from.clone() }),
            token: def.auth.token.as_ref().map(|s| VaultAuthSource { from: s.from.clone() }),
            config: def.auth.config.clone(),
        },
        mapping: def.mapping.clone(),
        fallback: def.fallback.iter().map(vault_def_for_provider).collect(),
    }
}

pub fn default_vault_method(provider: &str) -> &str {
    match provider {
        "aws" | "aws-secrets-manager" => "iam",
        "gcp" | "gcp-secret-manager" => "iam",
        "firebase" => "iam",
        "azure" | "azure-key-vault" => "iam",
        "hashicorp" | "hashicorp-vault" => "token",
        _ => "token",
    }
}

pub fn normalize_vault_token(vault: &str) -> String {
    let vault = vault.trim();
    let mut result = String::new();
    let mut last_underscore = false;
    for ch in vault.chars() {
        if ch.is_ascii_lowercase() {
            result.push(ch.to_ascii_uppercase());
            last_underscore = false;
        } else if ch.is_ascii_uppercase() || ch.is_ascii_digit() {
            result.push(ch);
            last_underscore = false;
        } else if !last_underscore {
            result.push('_');
            last_underscore = true;
        }
    }
    result.trim_matches('_').to_string()
}

pub fn get_vault_passphrase_env_var(vault: &str) -> String {
    let token = normalize_vault_token(vault);
    if !token.is_empty() && token != "DEFAULT" {
        format!("CNOS_SECRET_PASSPHRASE_{}", token)
    } else {
        "CNOS_SECRET_PASSPHRASE".into()
    }
}

pub fn get_vault_session_key_env_var(vault: &str) -> String {
    let token = normalize_vault_token(vault);
    let token = if token.is_empty() { "DEFAULT".to_string() } else { token };
    format!("__CNOS_VAULT_KEY_{}__", token)
}
