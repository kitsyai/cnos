"""CNOS Python runtime — public API.

Module-level functions mirror Go's singleton.go delegating functions.
Call cnos.ready() or cnos.load() before using the module-level read functions.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

# Re-export the main public types
from cnos.errors import CnosError
from cnos.exports import (
    config_hash,
    format_message,
    log_message,
    to_env,
    to_namespace,
    to_object as _exports_to_object,
    to_public_env as _exports_to_public_env,
    to_server_projection,
)
from cnos.inspect import InspectResult
from cnos.loader import (
    CnosOptions,
    _reset_default_runtime,
    bootstrap_default_runtime,
    default_runtime,
    load,
    load_projection,
    load_projection_file,
    ready,
    set_default_runtime,
)
from cnos.projection import ServerProjection
from cnos.runtime import CnosRuntime
from cnos.types import (
    ConfigOrigin,
    DerivedFormula,
    SecretReference,
    SecretVaultProvider,
    SecretVaultProviderFactory,
    ToEnvOptions,
    ToPublicEnvOptions,
    VaultAuthConfig,
    VaultAuthDefinition,
    VaultAuthSource,
    VaultDefinition,
)

# ---------------------------------------------------------------------------
# Module-level singleton API — mirror Go's package-level functions
# ---------------------------------------------------------------------------

def read(key: str) -> Tuple[Any, bool]:
    return default_runtime().read(key)


def require(key: str) -> Any:
    return default_runtime().require(key)


def read_or(key: str, fallback: Any) -> Any:
    return default_runtime().read_or(key, fallback)


def value(path: str) -> Tuple[Any, bool]:
    return default_runtime().value(path)


def secret(path: str) -> Tuple[Any, bool]:
    return default_runtime().secret(path)


def meta(path: str) -> Tuple[Any, bool]:
    return default_runtime().meta(path)


def public(path: str) -> Tuple[Any, bool]:
    return default_runtime().public(path)


def inspect(key: str) -> InspectResult:
    return default_runtime().inspect(key)


def get_to_object() -> Dict[str, Any]:
    return _exports_to_object(default_runtime())


def get_to_namespace(namespace: str) -> Dict[str, Any]:
    return to_namespace(default_runtime(), namespace)


def get_to_env(options: Optional[ToEnvOptions] = None) -> Dict[str, str]:
    return to_env(default_runtime(), options)


def get_to_public_env(options: Optional[ToPublicEnvOptions] = None) -> Dict[str, str]:
    return _exports_to_public_env(default_runtime(), options)


def get_to_server_projection() -> ServerProjection:
    return to_server_projection(default_runtime())


def get_format(message: str) -> str:
    return format_message(default_runtime(), message)


def get_log(message: str) -> str:
    return log_message(default_runtime(), message)


def refresh_secrets() -> None:
    default_runtime().refresh_secrets()


def refresh_secret(path: str) -> None:
    default_runtime().refresh_secret(path)


def register_runtime_provider(namespace: str, provider: Any) -> None:
    default_runtime().register_runtime_provider(namespace, provider)


def register_secret_vault_providers(*factories: SecretVaultProviderFactory) -> None:
    default_runtime().register_secret_vault_providers(*factories)


# ---------------------------------------------------------------------------
# Contract-standard names (consistent with Go, Rust, Java, C#, Kotlin)
# ---------------------------------------------------------------------------

def reset_default_runtime() -> None:
    """Reset the default runtime. Use in tests to restore a clean state."""
    _reset_default_runtime()


def to_object() -> Dict[str, Any]:
    """Return all resolved config keys as a nested dict (singleton shortcut)."""
    return _exports_to_object(default_runtime())


def to_public_env(options: Optional[ToPublicEnvOptions] = None) -> Dict[str, str]:
    """Export promoted public keys as env-var pairs (singleton shortcut)."""
    return _exports_to_public_env(default_runtime(), options)


def format(message: str) -> str:  # noqa: A001 — intentional shadow of builtin
    """Substitute ${key} patterns in message with resolved config values."""
    return format_message(default_runtime(), message)


# Bootstrap eagerly (mirrors Go's init())
bootstrap_default_runtime()

__all__ = [
    # Error
    "CnosError",
    # Main classes
    "CnosRuntime",
    "CnosOptions",
    "ServerProjection",
    "InspectResult",
    # Types
    "DerivedFormula",
    "SecretReference",
    "VaultDefinition",
    "VaultAuthConfig",
    "VaultAuthDefinition",
    "VaultAuthSource",
    "ConfigOrigin",
    "ToEnvOptions",
    "ToPublicEnvOptions",
    "SecretVaultProvider",
    "SecretVaultProviderFactory",
    # Loader
    "load",
    "load_projection",
    "load_projection_file",
    "ready",
    "set_default_runtime",
    "default_runtime",
    "reset_default_runtime",
    # Module-level read API
    "read",
    "require",
    "read_or",
    "value",
    "secret",
    "meta",
    "public",
    "inspect",
    # Contract-standard names
    "to_object",
    "to_public_env",
    "format",
    # Export API (legacy names kept for backwards compat)
    "get_to_object",
    "get_to_namespace",
    "get_to_env",
    "get_to_public_env",
    "get_to_server_projection",
    "get_format",
    "get_log",
    "config_hash",
    "refresh_secrets",
    "refresh_secret",
    "register_runtime_provider",
    "register_secret_vault_providers",
]
