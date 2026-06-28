use std::collections::HashMap;
use cnos::{CnosError, SecretVaultProvider, SecretVaultProviderFactory, VaultAuthConfig, VaultDefinition};
use cnos_gcp::GcpSecretManagerProvider;
use serde_json::Value;

pub struct FirebaseSecretsProvider {
    inner: GcpSecretManagerProvider,
}

impl FirebaseSecretsProvider {
    pub fn new(vault_id: impl Into<String>, definition: &VaultDefinition) -> Self {
        FirebaseSecretsProvider { inner: GcpSecretManagerProvider::new(vault_id, definition) }
    }

    pub fn factory() -> SecretVaultProviderFactory {
        SecretVaultProviderFactory::new("firebase", |vault_id, def| {
            Ok(Box::new(FirebaseSecretsProvider::new(vault_id, &def)))
        })
    }
}

impl SecretVaultProvider for FirebaseSecretsProvider {
    fn authenticate(&mut self, auth: VaultAuthConfig) -> Result<(), CnosError> {
        self.inner.authenticate(auth)
    }

    fn batch_get(&self, refs: &[String]) -> Result<HashMap<String, Value>, CnosError> {
        self.inner.batch_get(refs)
    }

    fn get(&self, reference: &str) -> Result<Option<Value>, CnosError> {
        self.inner.get(reference)
    }
}
