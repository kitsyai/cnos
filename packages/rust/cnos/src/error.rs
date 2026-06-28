use std::fmt;

#[derive(Debug)]
pub enum CnosError {
    ProjectionNotFound,
    InvalidProjection(String),
    MissingKey(String),
    ParseError(String),
    CryptoError(String),
    IoError(String),
    VaultError(String),
    DerivedError(String),
    RuntimeProviderError(String),
    Other(String),
}

impl fmt::Display for CnosError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CnosError::ProjectionNotFound => write!(f, "cnos: no server projection found"),
            CnosError::InvalidProjection(msg) => write!(f, "cnos: invalid server projection: {}", msg),
            CnosError::MissingKey(key) => write!(f, "cnos: missing required config key: {}", key),
            CnosError::ParseError(msg) => write!(f, "cnos: {}", msg),
            CnosError::CryptoError(msg) => write!(f, "cnos: crypto error: {}", msg),
            CnosError::IoError(msg) => write!(f, "cnos: io error: {}", msg),
            CnosError::VaultError(msg) => write!(f, "cnos: vault error: {}", msg),
            CnosError::DerivedError(msg) => write!(f, "cnos: derived error: {}", msg),
            CnosError::RuntimeProviderError(msg) => write!(f, "cnos: {}", msg),
            CnosError::Other(msg) => write!(f, "cnos: {}", msg),
        }
    }
}

impl std::error::Error for CnosError {}

impl From<std::io::Error> for CnosError {
    fn from(e: std::io::Error) -> Self {
        CnosError::IoError(e.to_string())
    }
}

impl From<serde_json::Error> for CnosError {
    fn from(e: serde_json::Error) -> Self {
        CnosError::ParseError(e.to_string())
    }
}

pub fn is_projection_not_found(err: &CnosError) -> bool {
    matches!(err, CnosError::ProjectionNotFound)
}
