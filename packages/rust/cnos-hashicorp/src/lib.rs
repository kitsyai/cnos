use std::collections::HashMap;
use cnos::{CnosError, SecretVaultProvider, SecretVaultProviderFactory, VaultAuthConfig, VaultDefinition};
use serde_json::Value;

pub struct HashiCorpVaultProvider {
    address: String,
    mount: String,
    token: Option<String>,
}

impl HashiCorpVaultProvider {
    pub fn new(_vault_id: impl Into<String>, definition: &VaultDefinition) -> Self {
        let cfg = &definition.auth.config;
        let address = cfg.get("address")
            .or_else(|| cfg.get("url"))
            .and_then(|v| v.as_str())
            .unwrap_or("http://127.0.0.1:8200")
            .to_string();
        let mount = cfg.get("mount")
            .and_then(|v| v.as_str())
            .unwrap_or("secret")
            .to_string();
        HashiCorpVaultProvider { address, mount, token: None }
    }

    pub fn factory() -> SecretVaultProviderFactory {
        SecretVaultProviderFactory::new("hashicorp", |vault_id, def| {
            Ok(Box::new(HashiCorpVaultProvider::new(vault_id, &def)))
        })
    }
}

impl SecretVaultProvider for HashiCorpVaultProvider {
    fn authenticate(&mut self, auth: VaultAuthConfig) -> Result<(), CnosError> {
        if !auth.token.is_empty() {
            self.token = Some(auth.token);
        }
        Ok(())
    }

    fn batch_get(&self, refs: &[String]) -> Result<HashMap<String, Value>, CnosError> {
        let token = self.token.as_deref().unwrap_or("")
            .to_string()
            .or_else_if_empty(|| std::env::var("VAULT_TOKEN").ok());

        let token = match token {
            Some(t) if !t.is_empty() => t,
            _ => return Err(CnosError::VaultError("HashiCorp Vault: no token provided".into())),
        };

        let client = reqwest::blocking::Client::new();
        let mut results = HashMap::new();

        for ref_ in refs {
            // Support "path#field" format
            let (path, field) = match ref_.find('#') {
                Some(i) => (&ref_[..i], Some(&ref_[i + 1..])),
                None => (ref_.as_str(), None),
            };
            let url = format!("{}/v1/{}/data/{}", self.address, self.mount, path);
            match client.get(&url)
                .header("X-Vault-Token", &token)
                .send()
                .and_then(|r| r.json::<serde_json::Value>())
            {
                Ok(resp) => {
                    let data = resp.get("data").and_then(|d| d.get("data"));
                    if let Some(data) = data {
                        let field_key = field.unwrap_or("value");
                        if let Some(v) = data.get(field_key) {
                            results.insert(ref_.clone(), v.clone());
                        }
                    }
                }
                Err(_) => {}
            }
        }
        Ok(results)
    }

    fn get(&self, reference: &str) -> Result<Option<Value>, CnosError> {
        let results = self.batch_get(&[reference.to_string()])?;
        Ok(results.into_values().next())
    }
}

trait OrElseIfEmpty {
    fn or_else_if_empty<F: FnOnce() -> Option<String>>(self, f: F) -> Option<String>;
}

impl OrElseIfEmpty for String {
    fn or_else_if_empty<F: FnOnce() -> Option<String>>(self, f: F) -> Option<String> {
        if self.is_empty() { f() } else { Some(self) }
    }
}
