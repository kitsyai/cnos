use std::collections::HashMap;
use cnos::{CnosError, SecretVaultProvider, SecretVaultProviderFactory, VaultAuthConfig, VaultDefinition};
use serde_json::Value;

pub struct GcpSecretManagerProvider {
    project_id: String,
    token: Option<String>,
}

impl GcpSecretManagerProvider {
    pub fn new(vault_id: impl Into<String>, definition: &VaultDefinition) -> Self {
        let project_id = definition.auth.config.get("projectId")
            .or_else(|| definition.auth.config.get("project_id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| vault_id.into());
        GcpSecretManagerProvider { project_id, token: None }
    }

    pub fn factory() -> SecretVaultProviderFactory {
        SecretVaultProviderFactory::new("gcp", |vault_id, def| {
            Ok(Box::new(GcpSecretManagerProvider::new(vault_id, &def)))
        })
    }

    fn access_token(&self) -> Result<String, CnosError> {
        if let Some(ref t) = self.token { return Ok(t.clone()); }
        // Fallback: use metadata server for GCE/Cloud Run ambient credentials
        let resp = reqwest::blocking::Client::new()
            .get("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token")
            .header("Metadata-Flavor", "Google")
            .send()
            .and_then(|r| r.json::<serde_json::Value>())
            .map_err(|e| CnosError::VaultError(format!("GCP metadata server error: {}", e)))?;
        resp.get("access_token")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| CnosError::VaultError("GCP: no access_token in metadata response".into()))
    }
}

impl SecretVaultProvider for GcpSecretManagerProvider {
    fn authenticate(&mut self, auth: VaultAuthConfig) -> Result<(), CnosError> {
        if !auth.token.is_empty() {
            self.token = Some(auth.token);
        }
        Ok(())
    }

    fn batch_get(&self, refs: &[String]) -> Result<HashMap<String, Value>, CnosError> {
        let token = self.access_token()?;
        let client = reqwest::blocking::Client::new();
        let mut results = HashMap::new();
        for ref_ in refs {
            let secret_name = ref_.replace('.', "_");
            let url = format!(
                "https://secretmanager.googleapis.com/v1/projects/{}/secrets/{}/versions/latest:access",
                self.project_id, secret_name
            );
            match client.get(&url)
                .bearer_auth(&token)
                .send()
                .and_then(|r| r.json::<serde_json::Value>())
            {
                Ok(resp) => {
                    if let Some(data) = resp.get("payload")
                        .and_then(|p| p.get("data"))
                        .and_then(|d| d.as_str())
                    {
                        // GCP returns base64-encoded value
                        if let Ok(bytes) = base64_decode(data) {
                            if let Ok(s) = String::from_utf8(bytes) {
                                results.insert(ref_.clone(), Value::String(s));
                            }
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

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    // Standard base64 decoding
    let s = s.trim();
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [0u8; 256];
    for (i, &c) in alphabet.iter().enumerate() { lookup[c as usize] = i as u8; }

    let s_bytes = s.as_bytes();
    let len = s_bytes.len();
    if len % 4 != 0 { return Err("invalid base64 length".into()); }
    let mut result = Vec::with_capacity(len / 4 * 3);
    let mut i = 0;
    while i < len {
        let b0 = if s_bytes[i] == b'=' { 0 } else { lookup[s_bytes[i] as usize] };
        let b1 = if s_bytes[i+1] == b'=' { 0 } else { lookup[s_bytes[i+1] as usize] };
        let b2 = if s_bytes[i+2] == b'=' { 0 } else { lookup[s_bytes[i+2] as usize] };
        let b3 = if s_bytes[i+3] == b'=' { 0 } else { lookup[s_bytes[i+3] as usize] };
        result.push((b0 << 2) | (b1 >> 4));
        if s_bytes[i+2] != b'=' { result.push((b1 << 4) | (b2 >> 2)); }
        if s_bytes[i+3] != b'=' { result.push((b2 << 6) | b3); }
        i += 4;
    }
    Ok(result)
}
