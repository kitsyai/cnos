use std::collections::HashMap;
use cnos::{CnosError, SecretVaultProvider, SecretVaultProviderFactory, VaultAuthConfig, VaultDefinition};
use serde_json::Value;

pub struct AzureKeyVaultProvider {
    vault_url: String,
}

impl AzureKeyVaultProvider {
    pub fn new(vault_id: impl Into<String>, definition: &VaultDefinition) -> Self {
        let vault_url = definition.auth.config.get("vaultUrl")
            .or_else(|| definition.auth.config.get("vault_url"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                let id = vault_id.into();
                format!("https://{}.vault.azure.net", id)
            });
        AzureKeyVaultProvider { vault_url }
    }

    pub fn factory() -> SecretVaultProviderFactory {
        SecretVaultProviderFactory::new("azure", |vault_id, def| {
            Ok(Box::new(AzureKeyVaultProvider::new(vault_id, &def)))
        })
    }

    fn block_on<F: std::future::Future>(&self, f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }
}

impl SecretVaultProvider for AzureKeyVaultProvider {
    fn authenticate(&mut self, _auth: VaultAuthConfig) -> Result<(), CnosError> {
        Ok(()) // Azure uses DefaultAzureCredential
    }

    fn batch_get(&self, refs: &[String]) -> Result<HashMap<String, Value>, CnosError> {
        self.block_on(async {
            let credential = azure_identity::DefaultAzureCredential::new()
                .map_err(|e| CnosError::VaultError(format!("Azure credential error: {}", e)))?;
            let client = azure_security_keyvault_secrets::SecretClient::new(
                &self.vault_url,
                std::sync::Arc::new(credential),
            ).map_err(|e| CnosError::VaultError(format!("Azure Key Vault client error: {}", e)))?;

            let mut results = HashMap::new();
            for ref_ in refs {
                // Azure secret names cannot contain dots; replace with dashes
                let secret_name = ref_.replace('.', "-");
                match client.get(&secret_name, None).await {
                    Ok(resp) => {
                        if let Some(value) = resp.value {
                            results.insert(ref_.clone(), Value::String(value));
                        }
                    }
                    Err(_) => {}
                }
            }
            Ok(results)
        })
    }

    fn get(&self, reference: &str) -> Result<Option<Value>, CnosError> {
        let results = self.batch_get(&[reference.to_string()])?;
        Ok(results.into_values().next())
    }
}
