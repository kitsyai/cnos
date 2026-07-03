pub mod error;
pub mod env;
pub mod projection;
pub mod jscompat;
pub mod discover;
pub mod vault;
pub mod derive;
pub mod manifest;
pub mod secrets;
pub mod graph;
pub mod runtime;
pub mod singleton;

pub use error::{CnosError, is_projection_not_found};
pub use runtime::{CnosRuntime, Options, ToEnvOptions, ToPublicEnvOptions};
pub use vault::{SecretVaultProvider, SecretVaultProviderFactory, VaultAuthConfig, VaultDefinition, VaultAuthDefinition, VaultAuthSource};
pub use projection::{ServerProjection, DerivedFormula, ProjectionMeta};

// Singleton (module-level) API — library code can call cnos::read(), cnos::ready(), etc.
// without holding a CnosRuntime instance. The composition root calls cnos::ready() once.
pub use singleton::{
    ready, read, require, read_or, value, secret, meta,
    set_default_runtime, default_runtime, reset_default_runtime,
    to_object, to_public_env, format, refresh_secrets, refresh_secret,
};
