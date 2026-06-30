use std::collections::HashMap;
use std::sync::Arc;
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

// azure_identity 1.0 dropped DefaultAzureCredential. Prefer service principal from env
// (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET), then fall back to
// ManagedIdentityCredential for cloud-hosted workloads.
fn build_credential() -> Result<Arc<dyn azure_core::credentials::TokenCredential>, CnosError> {
    let tenant = std::env::var("AZURE_TENANT_ID").ok();
    let client = std::env::var("AZURE_CLIENT_ID").ok();
    let secret = std::env::var("AZURE_CLIENT_SECRET").ok();

    if let (Some(tenant_id), Some(client_id), Some(client_secret)) = (tenant, client, secret) {
        return azure_identity::ClientSecretCredential::new(
            &tenant_id,
            client_id,
            client_secret.into(),
            None,
        )
        .map(|c| c as Arc<dyn azure_core::credentials::TokenCredential>)
        .map_err(|e| CnosError::VaultError(format!("Azure service-principal credential error: {}", e)));
    }

    azure_identity::ManagedIdentityCredential::new(None)
        .map(|c| c as Arc<dyn azure_core::credentials::TokenCredential>)
        .map_err(|e| CnosError::VaultError(format!("Azure managed-identity credential error: {}", e)))
}

impl SecretVaultProvider for AzureKeyVaultProvider {
    fn authenticate(&mut self, _auth: VaultAuthConfig) -> Result<(), CnosError> {
        Ok(()) // credential resolved per-call via env vars or managed identity
    }

    fn batch_get(&self, refs: &[String]) -> Result<HashMap<String, Value>, CnosError> {
        self.block_on(async {
            let credential = build_credential()?;
            let client = azure_security_keyvault_secrets::SecretClient::new(
                &self.vault_url,
                credential,
                None,
            ).map_err(|e| CnosError::VaultError(format!("Azure Key Vault client error: {}", e)))?;

            let mut results = HashMap::new();
            for ref_ in refs {
                // Azure secret names cannot contain dots; replace with dashes
                let secret_name = ref_.replace('.', "-");
                match client.get_secret(&secret_name, None).await {
                    Ok(resp) => {
                        if let Ok(secret) = resp.into_model() {
                            if let Some(value) = secret.value {
                                results.insert(ref_.clone(), Value::String(value));
                            }
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
