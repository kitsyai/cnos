use std::collections::HashMap;
use cnos::{CnosError, SecretVaultProvider, SecretVaultProviderFactory, VaultAuthConfig, VaultDefinition};
use serde_json::Value;

pub struct AwsSecretsManagerProvider {
    #[allow(dead_code)]
    vault_id: String,
    region: Option<String>,
}

impl AwsSecretsManagerProvider {
    pub fn new(vault_id: impl Into<String>, definition: &VaultDefinition) -> Self {
        let region = definition.auth.config.get("region")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        AwsSecretsManagerProvider { vault_id: vault_id.into(), region }
    }

    pub fn factory() -> SecretVaultProviderFactory {
        SecretVaultProviderFactory::new("aws", |vault_id, def| {
            Ok(Box::new(AwsSecretsManagerProvider::new(vault_id, &def)))
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

impl SecretVaultProvider for AwsSecretsManagerProvider {
    fn authenticate(&mut self, _auth: VaultAuthConfig) -> Result<(), CnosError> {
        Ok(()) // AWS uses IAM ambient credentials
    }

    fn batch_get(&self, refs: &[String]) -> Result<HashMap<String, Value>, CnosError> {
        self.block_on(async {
            let config = if let Some(ref region) = self.region {
                aws_config::defaults(aws_config::BehaviorVersion::latest())
                    .region(aws_config::meta::region::RegionProviderChain::first_try(
                        aws_sdk_secretsmanager::config::Region::new(region.clone())
                    ))
                    .load()
                    .await
            } else {
                aws_config::defaults(aws_config::BehaviorVersion::latest()).load().await
            };
            let client = aws_sdk_secretsmanager::Client::new(&config);

            let mut results = HashMap::new();
            for ref_ in refs {
                match client.get_secret_value().secret_id(ref_).send().await {
                    Ok(out) => {
                        let secret = out.secret_string()
                            .map(|s| Value::String(s.to_string()))
                            .or_else(|| out.secret_binary()
                                .map(|b| Value::String(base64_encode(b.as_ref()))));
                        if let Some(v) = secret {
                            results.insert(ref_.clone(), v);
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

fn base64_encode(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect()
}
