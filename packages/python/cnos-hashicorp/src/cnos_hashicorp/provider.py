"""HashiCorp Vault CNOS vault provider — mirrors Go's hashicorpvault.go."""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from cnos.errors import CnosError
from cnos.types import (
    SecretVaultProvider,
    SecretVaultProviderFactory,
    VaultAuthConfig,
    VaultDefinition,
)

PROVIDER_NAME = "hashicorp-vault"


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


def _read_version(value: Any) -> int:
    if isinstance(value, int) and value in (1, 2):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if stripped in ("1", "kv-v1"):
            return 1
        if stripped in ("2", "kv-v2"):
            return 2
    return 0


def _unique_sorted(refs: List[str]) -> List[str]:
    return sorted(set(refs))


def _join_path(*segments: str) -> str:
    parts = []
    for seg in segments:
        trimmed = seg.strip("/")
        if trimmed:
            parts.append(trimmed)
    return "/".join(parts)


class _ParsedRef:
    def __init__(self, path: str, field: str, explicit_field: bool) -> None:
        self.path = path
        self.field = field
        self.explicit_field = explicit_field


def _parse_vault_ref(ref: str) -> _ParsedRef:
    index = ref.rfind("#")
    if index == -1:
        return _ParsedRef(path=ref, field="value", explicit_field=False)
    field = ref[index + 1:] or "value"
    return _ParsedRef(path=ref[:index], field=field, explicit_field=True)


def _read_kv_data(data: Dict[str, Any], version: int) -> Optional[Dict[str, Any]]:
    if version != 2:
        return data
    nested = data.get("data")
    if isinstance(nested, dict):
        return nested
    return None


def _decode_vault_value(
    data: Optional[Dict[str, Any]], field: str, explicit_field: bool
) -> Optional[str]:
    if data is None:
        return None
    val = data.get(field)
    if val is not None:
        s = _primitive_string(val)
        if s is not None:
            return s
    if explicit_field:
        return None
    # Try to find a single primitive field
    primitives = []
    for v in data.values():
        s = _primitive_string(v)
        if s is not None:
            primitives.append(s)
    if len(primitives) == 1:
        return primitives[0]
    return None


def _primitive_string(value: Any) -> Optional[str]:
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(value)
    return None


class HashiCorpVaultProvider(SecretVaultProvider):
    """HashiCorp Vault KV provider. Supports injecting a mock client for tests."""

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
        self._token: str = ""
        self._authenticated = False

    @staticmethod
    def _read_config(definition: VaultDefinition) -> Dict[str, Any]:
        config = definition.auth.config or {}
        version = _read_version(config.get("version"))
        if version == 0:
            version = 2
        mount = _string_config(config, "mount") or "secret"
        return {
            "address": _first_string_config(config, "address", "endpoint", "url"),
            "mount": mount,
            "namespace": _string_config(config, "namespace"),
            "version": version,
            "path": _string_config(config, "path"),
        }

    def authenticate(self, auth: VaultAuthConfig) -> None:
        if auth.method != "token" or not auth.token:
            raise CnosError(
                f'vault "{self._vault_id}" uses {PROVIDER_NAME} and requires token authentication'
            )
        self._token = auth.token
        self._authenticated = True
        if self._client is None:
            self._client = self._build_client()

    def _build_client(self) -> Any:
        try:
            import hvac  # type: ignore[import]
        except ImportError as exc:
            raise CnosError(
                "cnos-hashicorp: hvac is required. Install with: pip install hvac"
            ) from exc
        kwargs: Dict[str, Any] = {}
        if self._config["address"]:
            kwargs["url"] = self._config["address"]
        client = hvac.Client(**kwargs)
        client.token = self._token
        return client

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
        external = self._external_ref(ref)
        parsed = _parse_vault_ref(external)
        read_path = self._read_path(parsed.path)
        data, status = self._client_read(read_path)
        if status == 404 or data is None:
            return None
        kv_data = _read_kv_data(data, self._config["version"])
        return _decode_vault_value(kv_data, parsed.field, parsed.explicit_field)

    def _client_read(self, path: str) -> Tuple[Optional[Dict[str, Any]], int]:
        """Returns (data, status_code). 404 on not-found."""
        try:
            data, status = self._client.read(
                path,
                self._token,
                self._config["namespace"],
            )
            return data, status
        except Exception as exc:
            if self._is_not_found(exc):
                return None, 404
            raise CnosError(f"cnos-hashicorp: read {path!r} failed: {exc}") from exc

    def _read_path(self, path: str) -> str:
        if self._config["version"] == 2:
            return _join_path(self._config["mount"], "data", self._config["path"], path)
        return _join_path(self._config["mount"], self._config["path"], path)

    def _external_ref(self, ref: str) -> str:
        mapping = self._definition.mapping or {}
        for external, logical in mapping.items():
            if logical == ref:
                return external
        return ref

    @staticmethod
    def _is_not_found(exc: Exception) -> bool:
        cls_name = type(exc).__name__
        if "InvalidPath" in cls_name or "NotFound" in cls_name:
            return True
        status = getattr(exc, "status_code", None)
        return status == 404


def factory(client: Any = None) -> SecretVaultProviderFactory:
    """Return a SecretVaultProviderFactory for HashiCorp Vault.

    Pass client= to inject a mock for tests.
    """
    def create(vault_id: str, definition: VaultDefinition) -> HashiCorpVaultProvider:
        return HashiCorpVaultProvider(vault_id, definition, client=client)

    return SecretVaultProviderFactory(provider=PROVIDER_NAME, create=create)
