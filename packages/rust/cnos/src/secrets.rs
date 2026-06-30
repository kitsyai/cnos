use std::collections::HashMap;
use std::path::PathBuf;
use aes_gcm::{Aes256Gcm, Key, Nonce};
use aes_gcm::aead::{Aead, KeyInit};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::Value;
use crate::env::CnosEnvironment;
use crate::error::CnosError;
use crate::projection::VaultDef;
use crate::vault::{
    get_vault_passphrase_env_var, get_vault_session_key_env_var, normalize_vault_token,
};

const KEY_LENGTH: usize = 32;
const IV_LENGTH: usize = 12;
const AUTH_TAG_LENGTH: usize = 16;
const KEYSTORE_VERSION: u32 = 1;
const DEFAULT_SECRET_DIR: &str = "~/.cnos/secrets";

pub fn resolve_secret_home(env: &CnosEnvironment, override_path: Option<&str>) -> Result<String, CnosError> {
    if let Some(p) = override_path.filter(|p| !p.is_empty()) {
        return expand_home(p);
    }
    if let Some(v) = env.get("CNOS_SECRET_HOME").filter(|v| !v.is_empty()) {
        return expand_home(&v);
    }
    expand_home(DEFAULT_SECRET_DIR)
}

fn expand_home(path: &str) -> Result<String, CnosError> {
    use crate::discover::expand_home_path;
    expand_home_path(path).map(|p| p.to_string_lossy().into_owned())
}

pub fn decrypt_secret_payload_from_env(env: &CnosEnvironment) -> Result<HashMap<String, Value>, CnosError> {
    let serialized = match env.get(crate::projection::SECRET_PAYLOAD_ENV_VAR).filter(|v| !v.is_empty()) {
        Some(s) => s,
        None => return Ok(HashMap::new()),
    };
    let session_key_hex = match env.get(crate::projection::SESSION_KEY_ENV_VAR).filter(|v| !v.is_empty()) {
        Some(s) => s,
        None => return Ok(HashMap::new()),
    };

    let key = hex::decode(&session_key_hex)
        .map_err(|_| CnosError::CryptoError("invalid session key hex".into()))?;
    if key.len() != KEY_LENGTH {
        return Err(CnosError::CryptoError("invalid session key for encrypted secret payload".into()));
    }

    let payload: EncryptedPayload = serde_json::from_str(&serialized)
        .map_err(|e| CnosError::ParseError(format!("parse encrypted secret payload: {}", e)))?;

    let plaintext = decrypt_payload(&payload, &key)?;
    let result: HashMap<String, Value> = serde_json::from_slice(&plaintext)
        .map_err(|e| CnosError::ParseError(format!("decode encrypted secret payload: {}", e)))?;
    Ok(result)
}

pub fn read_local_vault_secrets(
    secret_home: &str,
    vault: &str,
    definition: Option<&VaultDef>,
    env: &CnosEnvironment,
) -> Result<HashMap<String, String>, CnosError> {
    let meta_path = PathBuf::from(secret_home).join("vaults").join(vault).join("meta.yml");
    let meta_bytes = std::fs::read(&meta_path)
        .map_err(|_| CnosError::VaultError(format!("missing CNOS vault metadata for {:?}", vault)))?;

    let meta = parse_local_vault_metadata(&meta_bytes)?;
    let key = resolve_local_vault_key(secret_home, vault, &meta, definition, env)?;

    let keystore_path = PathBuf::from(secret_home).join("vaults").join(vault).join("keystore.enc");
    let buffer = std::fs::read(&keystore_path)
        .map_err(|e| CnosError::VaultError(format!("read local vault keystore for {:?}: {}", vault, e)))?;

    let payload = decrypt_local_vault_payload(&buffer, &key, &meta)?;
    Ok(payload)
}

fn resolve_local_vault_key(
    secret_home: &str,
    vault: &str,
    meta: &LocalVaultMeta,
    definition: Option<&VaultDef>,
    env: &CnosEnvironment,
) -> Result<Vec<u8>, CnosError> {
    // 1. Session key env var
    let session_var = get_vault_session_key_env_var(vault);
    if let Some(hex_val) = env.get(&session_var).filter(|v| !v.is_empty()) {
        if let Ok(key) = hex::decode(&hex_val) {
            if key.len() == KEY_LENGTH {
                return Ok(key);
            }
        }
    }

    // 2. Session key file
    let session_path = PathBuf::from(secret_home).join("sessions").join(format!("{}.json", vault));
    if let Ok(bytes) = std::fs::read(&session_path) {
        if let Ok(doc) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let Some(hex_val) = doc.get("derivedKey").and_then(|v| v.as_str()) {
                if let Ok(key) = hex::decode(hex_val) {
                    if key.len() == KEY_LENGTH {
                        return Ok(key);
                    }
                }
            }
        }
    }

    // 3. Auth sources from definition
    let auth_sources = resolve_local_vault_auth_sources(vault, definition);
    for source in &auth_sources {
        if let Some(passphrase) = resolve_vault_source_value(source, env) {
            return derive_local_vault_key(&passphrase, vault, meta);
        }
    }

    // 4. Generic passphrase env var
    if let Some(passphrase) = resolve_vault_passphrase(vault, env) {
        return derive_local_vault_key(&passphrase, vault, meta);
    }

    let tried: Vec<String> = std::iter::once(session_var)
        .chain(auth_sources.into_iter())
        .collect();
    Err(CnosError::VaultError(format!(
        "cannot authenticate to vault {:?}. Tried: {}. Set {} or run cnos vault auth {}",
        vault, tried.join(", "), get_vault_passphrase_env_var(vault), vault
    )))
}

fn resolve_local_vault_auth_sources(vault: &str, definition: Option<&VaultDef>) -> Vec<String> {
    if let Some(def) = definition {
        if let Some(pp) = &def.auth.passphrase {
            if !pp.from.is_empty() {
                return pp.from.clone();
            }
        }
    }
    let token = normalize_vault_token(vault);
    let mut sources = Vec::new();
    if !token.is_empty() {
        sources.push(format!("env:CNOS_SECRET_PASSPHRASE_{}", token));
    }
    sources.push("env:CNOS_SECRET_PASSPHRASE".into());
    sources.push(format!("keychain:cnos/{}", vault));
    sources.push("prompt".into());
    sources
}

fn resolve_vault_source_value(source: &str, env: &CnosEnvironment) -> Option<String> {
    if let Some(var) = source.strip_prefix("env:") {
        return env.get(var).filter(|v| !v.trim().is_empty());
    }
    if let Some(path) = source.strip_prefix("file:") {
        if let Ok(bytes) = std::fs::read(path.trim()) {
            let s = std::str::from_utf8(&bytes).unwrap_or("").trim().to_string();
            if !s.is_empty() { return Some(s); }
        }
    }
    None
}

fn resolve_vault_passphrase(vault: &str, env: &CnosEnvironment) -> Option<String> {
    let specific_var = get_vault_passphrase_env_var(vault);
    if let Some(v) = env.get(&specific_var).filter(|v| !v.is_empty()) {
        return Some(v);
    }
    env.get("CNOS_SECRET_PASSPHRASE").filter(|v| !v.is_empty())
}

fn derive_local_vault_key(passphrase: &str, vault: &str, meta: &LocalVaultMeta) -> Result<Vec<u8>, CnosError> {
    let salt = BASE64.decode(&meta.salt)
        .map_err(|_| CnosError::CryptoError(format!("invalid salt for local vault {:?}", vault)))?;
    let mut key = vec![0u8; KEY_LENGTH];
    pbkdf2_sha512(passphrase.as_bytes(), &salt, meta.iterations as u32, &mut key);
    Ok(key)
}

fn pbkdf2_sha512(password: &[u8], salt: &[u8], iterations: u32, out: &mut [u8]) {
    use sha2::Sha512;
    pbkdf2::pbkdf2_hmac::<Sha512>(password, salt, iterations, out);
}

struct LocalVaultMeta {
    iterations: usize,
    salt: String,
}

fn parse_local_vault_metadata(data: &[u8]) -> Result<LocalVaultMeta, CnosError> {
    let text = std::str::from_utf8(data)
        .map_err(|_| CnosError::VaultError("invalid CNOS vault metadata encoding".into()))?;
    let mut values: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        if let Some((k, v)) = line.split_once(':') {
            values.insert(k.trim().to_string(), v.trim().trim_matches(|c| c == '"' || c == '\'').to_string());
        }
    }

    let version: i64 = values.get("version").and_then(|v| v.parse().ok())
        .ok_or_else(|| CnosError::VaultError("invalid CNOS vault metadata".into()))?;
    let iterations: usize = values.get("iterations").and_then(|v| v.parse().ok())
        .ok_or_else(|| CnosError::VaultError("invalid CNOS vault metadata".into()))?;
    let algorithm = values.get("algorithm").map(|s| s.as_str()).unwrap_or("");
    let kdf = values.get("kdf").map(|s| s.as_str()).unwrap_or("");
    let salt = values.get("salt").cloned().unwrap_or_default();

    if version != 1 || algorithm != "aes-256-gcm" || kdf != "pbkdf2-sha512" || salt.is_empty() {
        return Err(CnosError::VaultError("invalid CNOS vault metadata".into()));
    }

    Ok(LocalVaultMeta { iterations, salt })
}

#[derive(serde::Deserialize)]
struct EncryptedPayload {
    iv: String,
    tag: String,
    ciphertext: String,
}

fn decrypt_payload(payload: &EncryptedPayload, key: &[u8]) -> Result<Vec<u8>, CnosError> {
    let iv = BASE64.decode(&payload.iv)
        .map_err(|e| CnosError::CryptoError(e.to_string()))?;
    let tag = BASE64.decode(&payload.tag)
        .map_err(|e| CnosError::CryptoError(e.to_string()))?;
    let ciphertext = BASE64.decode(&payload.ciphertext)
        .map_err(|e| CnosError::CryptoError(e.to_string()))?;

    if key.len() != 32 || iv.len() != IV_LENGTH {
        return Err(CnosError::CryptoError("invalid key or IV length".into()));
    }

    let aes_key = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(aes_key);
    let nonce = Nonce::from_slice(&iv);

    // aes-gcm expects ciphertext || tag
    let mut combined = ciphertext;
    combined.extend_from_slice(&tag);

    cipher.decrypt(nonce, combined.as_ref())
        .map_err(|_| CnosError::CryptoError("AES-GCM decryption failed".into()))
}

fn decrypt_local_vault_payload(
    buffer: &[u8],
    key: &[u8],
    _meta: &LocalVaultMeta,
) -> Result<HashMap<String, String>, CnosError> {
    if buffer.len() < 4 + IV_LENGTH + AUTH_TAG_LENGTH {
        return Err(CnosError::VaultError("invalid CNOS local vault keystore".into()));
    }

    let version = u32::from_le_bytes(buffer[..4].try_into().unwrap());
    if version != KEYSTORE_VERSION {
        return Err(CnosError::VaultError(format!("unsupported CNOS local vault keystore version: {}", version)));
    }

    let iv = &buffer[4..4 + IV_LENGTH];
    let tag = &buffer[4 + IV_LENGTH..4 + IV_LENGTH + AUTH_TAG_LENGTH];
    let ciphertext = &buffer[4 + IV_LENGTH + AUTH_TAG_LENGTH..];

    let payload = EncryptedPayload {
        iv: BASE64.encode(iv),
        tag: BASE64.encode(tag),
        ciphertext: BASE64.encode(ciphertext),
    };

    let plaintext = decrypt_payload(&payload, key)
        .map_err(|_| CnosError::VaultError("failed to decrypt CNOS local vault. Check vault authentication".into()))?;

    #[derive(serde::Deserialize)]
    struct LocalVaultPayload { secrets: HashMap<String, String> }

    let decoded: LocalVaultPayload = serde_json::from_slice(&plaintext)
        .map_err(|_| CnosError::VaultError("failed to decrypt CNOS local vault. Check vault authentication".into()))?;

    Ok(decoded.secrets)
}
