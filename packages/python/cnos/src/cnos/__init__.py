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
    to_object,
    to_public_env,
    to_server_projection,
)
from cnos.inspect import InspectResult
from cnos.loader import (
    CnosOptions,
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
    return to_object(default_runtime())


def get_to_namespace(namespace: str) -> Dict[str, Any]:
    return to_namespace(default_runtime(), namespace)


def get_to_env(options: Optional[ToEnvOptions] = None) -> Dict[str, str]:
    return to_env(default_runtime(), options)


def get_to_public_env(options: Optional[ToPublicEnvOptions] = None) -> Dict[str, str]:
    return to_public_env(default_runtime(), options)


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
    # Module-level read API
    "read",
    "require",
    "read_or",
    "value",
    "secret",
    "meta",
    "public",
    "inspect",
    # Export API
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
