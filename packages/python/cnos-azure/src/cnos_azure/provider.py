"""Azure Key Vault CNOS vault provider — mirrors Go's azurekeyvault.go."""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from urllib.parse import urlparse, unquote

from cnos.errors import CnosError
from cnos.types import (
    SecretVaultProvider,
    SecretVaultProviderFactory,
    VaultAuthConfig,
    VaultDefinition,
)

PROVIDER_NAME = "azure-key-vault"


def _string_config(config: Optional[Dict[str, Any]], key: str) -> str:
    if not config:
        return ""
    val = config.get(key, "")
    return str(val).strip() if val else ""


def _first_string_config(config: Optional[Dict[str, Any]], *keys: str) -> str:
    for key in keys:
        val = _string_config(config, key)
        if val:
            return val
    return ""


def _unique_sorted(refs: List[str]) -> List[str]:
    return sorted(set(refs))


class _ParsedSecretRef:
    def __init__(self, name: str, version: str = "", origin: str = "", full_url: bool = False) -> None:
        self.name = name
        self.version = version
        self.origin = origin
        self.full_url = full_url


def _parse_secret_ref(ref: str) -> _ParsedSecretRef:
    trimmed = ref.strip()
    if not trimmed.startswith("https://") and not trimmed.startswith("http://"):
        if not trimmed:
            raise CnosError("Azure Key Vault: secret name cannot be empty")
        return _ParsedSecretRef(name=trimmed)

    parsed = urlparse(trimmed)
    segments = [seg for seg in parsed.path.split("/") if seg]
    if len(segments) < 2 or len(segments) > 3 or segments[0] != "secrets":
        raise CnosError("Azure Key Vault: full URL must use /secrets/<name>[/<version>]")
    name = unquote(segments[1])
    if not name:
        raise CnosError("Azure Key Vault: secret name cannot be empty")
    origin = _origin_for_parsed(parsed)
    version = unquote(segments[2]) if len(segments) == 3 else ""
    return _ParsedSecretRef(name=name, version=version, origin=origin, full_url=True)


def _origin_for_url(raw_url: str) -> str:
    if not raw_url:
        return ""
    try:
        parsed = urlparse(raw_url.strip())
        return _origin_for_parsed(parsed)
    except Exception:
        return ""


def _origin_for_parsed(parsed: Any) -> str:
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}".lower()


class AzureKeyVaultProvider(SecretVaultProvider):
    """Azure Key Vault provider. Supports injecting a mock client for tests."""

    def __init__(
        self,
        vault_id: str,
        definition: VaultDefinition,
        client: Any = None,
    ) -> None:
        self._vault_id = vault_id
        self._definition = definition
        self._config = self._read_config(definition)
        self._client = client
        self._authenticated = False

    @staticmethod
    def _read_config(definition: VaultDefinition) -> Dict[str, str]:
        config = definition.auth.config or {}
        vault_url = _first_string_config(config, "vaultUrl", "url", "endpoint")
        return {
            "vault_url": vault_url,
            "origin": _origin_for_url(vault_url),
            "version": _string_config(config, "version"),
            "tenant_id": _first_string_config(config, "tenantId", "tenant"),
            "client_id": _string_config(config, "clientId"),
        }

    def authenticate(self, auth: VaultAuthConfig) -> None:
        if auth.method not in ("iam", "environment"):
            raise CnosError(
                f'vault "{self._vault_id}" uses {PROVIDER_NAME} and requires iam authentication'
            )
        self._authenticated = True
        if self._client is None:
            self._client = self._build_client()

    def _build_client(self) -> Any:
        vault_url = self._config["vault_url"]
        if not vault_url:
            raise CnosError(
                f'cnos-azure: vault "{self._vault_id}" requires auth.config.vaultUrl'
            )
        try:
            from azure.identity import DefaultAzureCredential  # type: ignore[import]
            from azure.keyvault.secrets import SecretClient  # type: ignore[import]
        except ImportError as exc:
            raise CnosError(
                "cnos-azure: azure-keyvault-secrets and azure-identity are required. "
                "Install with: pip install azure-keyvault-secrets azure-identity"
            ) from exc
        credential = DefaultAzureCredential(
            tenant_id=self._config["tenant_id"] or None
        )
        return SecretClient(vault_url=vault_url, credential=credential)

    def batch_get(self, refs: List[str]) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        for ref in _unique_sorted(refs):
            val = self._get_one(ref)
            if val is not None:
                result[ref] = val
        return result

    def get(self, ref: str) -> Optional[Any]:
        return self._get_one(ref)

    def _get_one(self, ref: str) -> Optional[str]:
        parsed = self._secret_ref_for_logical(ref)
        try:
            secret = self._client.get_secret(parsed.name, parsed.version)
            return self._decode_secret_value(secret)
        except Exception as exc:
            if self._is_not_found(exc):
                return None
            raise CnosError(
                f"cnos-azure: get_secret failed for {ref!r}: {exc}"
            ) from exc

    def _secret_ref_for_logical(self, ref: str) -> _ParsedSecretRef:
        external = self._external_secret_id(ref)
        parsed = _parse_secret_ref(external)
        if parsed.full_url and self._config["origin"] and parsed.origin != self._config["origin"]:
            raise CnosError(
                f'vault "{self._vault_id}" Azure Key Vault ref {external!r} '
                f'belongs to {parsed.origin}, but vaultUrl is {self._config["origin"]}'
            )
        if not parsed.version:
            parsed.version = self._config["version"]
        return parsed

    def _external_secret_id(self, ref: str) -> str:
        mapping = self._definition.mapping or {}
        for external, logical in mapping.items():
            if logical == ref:
                return external
        return ref

    @staticmethod
    def _decode_secret_value(secret: Any) -> Optional[str]:
        if secret is None:
            return None
        if isinstance(secret, str):
            return secret
        if isinstance(secret, bytes):
            return secret.decode("utf-8", errors="replace")
        value = getattr(secret, "value", None)
        if value is not None:
            if isinstance(value, bytes):
                return value.decode("utf-8", errors="replace")
            return str(value)
        return str(secret)

    @staticmethod
    def _is_not_found(exc: Exception) -> bool:
        cls_name = type(exc).__name__
        if "ResourceNotFound" in cls_name or "NotFound" in cls_name:
            return True
        status = getattr(exc, "status_code", None)
        return status == 404


def factory(client: Any = None) -> SecretVaultProviderFactory:
    """Return a SecretVaultProviderFactory for Azure Key Vault.

    Pass client= to inject a mock for tests.
    """
    def create(vault_id: str, definition: VaultDefinition) -> AzureKeyVaultProvider:
        return AzureKeyVaultProvider(vault_id, definition, client=client)

    return SecretVaultProviderFactory(provider=PROVIDER_NAME, create=create)
