"""GCP Secret Manager CNOS vault provider — mirrors Go's gcpsecretmanager.go."""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from cnos.errors import CnosError
from cnos.types import (
    SecretVaultProvider,
    SecretVaultProviderFactory,
    VaultAuthConfig,
    VaultDefinition,
)

PROVIDER_NAME = "gcp-secret-manager"

_FULL_SECRET_VERSION_RE = re.compile(
    r"^projects/[^/]+/(locations/[^/]+/)?secrets/[^/]+/versions/[^/]+$"
)


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


class GcpSecretManagerProvider(SecretVaultProvider):
    """GCP Secret Manager provider. Supports injecting a mock client for tests."""

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
        return {
            "project_id": _first_string_config(config, "projectId", "project_id"),
            "location": _string_config(config, "location"),
            "version": _string_config(config, "version"),
            "endpoint": _first_string_config(config, "endpoint", "apiEndpoint"),
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
        try:
            from google.cloud import secretmanager  # type: ignore[import]
        except ImportError as exc:
            raise CnosError(
                "cnos-gcp: google-cloud-secret-manager is required. "
                "Install with: pip install google-cloud-secret-manager"
            ) from exc
        kwargs: Dict[str, Any] = {}
        if self._config["endpoint"]:
            kwargs["client_options"] = {"api_endpoint": self._config["endpoint"]}
        return secretmanager.SecretManagerServiceClient(**kwargs)

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
        name = self._version_name_for_ref(ref)
        try:
            response = self._client.access_secret_version(name)
            return self._decode_secret_response(response)
        except Exception as exc:
            if self._is_not_found(exc):
                return None
            raise CnosError(
                f"cnos-gcp: access_secret_version failed for {ref!r}: {exc}"
            ) from exc

    def _version_name_for_ref(self, ref: str) -> str:
        secret_id = self._external_secret_id(ref)
        if _FULL_SECRET_VERSION_RE.match(secret_id):
            return secret_id
        project_id = self._resolve_project_id()
        version = self._config["version"] or "latest"
        if self._config["location"]:
            return (
                f"projects/{project_id}/locations/{self._config['location']}"
                f"/secrets/{secret_id}/versions/{version}"
            )
        return f"projects/{project_id}/secrets/{secret_id}/versions/{version}"

    def _resolve_project_id(self) -> str:
        if self._config["project_id"]:
            return self._config["project_id"]
        # Try to get from client / ADC
        if hasattr(self._client, "project_id"):
            pid = self._client.project_id
            if pid:
                return pid
        raise CnosError(
            f'vault "{self._vault_id}" requires auth.config.projectId '
            "when Google ADC cannot infer a project ID"
        )

    def _external_secret_id(self, ref: str) -> str:
        mapping = self._definition.mapping or {}
        for external, logical in mapping.items():
            if logical == ref:
                return external
        return ref

    @staticmethod
    def _decode_secret_response(response: Any) -> Optional[str]:
        if response is None:
            return None
        payload = getattr(response, "payload", None)
        if payload is not None:
            data = getattr(payload, "data", None)
            if data is not None:
                return GcpSecretManagerProvider._decode_secret_data(data)
        return GcpSecretManagerProvider._decode_secret_data(response)

    @staticmethod
    def _decode_secret_data(data: Any) -> Optional[str]:
        if data is None:
            return None
        if isinstance(data, str):
            return data
        if isinstance(data, bytes):
            return data.decode("utf-8", errors="replace")
        decode = getattr(data, "decode", None)
        if callable(decode):
            decoded = decode("utf-8", errors="replace")
            if isinstance(decoded, str):
                return decoded
        return str(data)

    @staticmethod
    def _is_not_found(exc: Exception) -> bool:
        cls_name = type(exc).__name__
        if "NotFound" in cls_name:
            return True
        # grpc status code 5 = NOT_FOUND
        code = getattr(exc, "code", None)
        if callable(code):
            try:
                code = code()
            except Exception:
                pass
        if hasattr(code, "value"):
            return code.value == 5
        return False


def factory(client: Any = None) -> SecretVaultProviderFactory:
    """Return a SecretVaultProviderFactory for GCP Secret Manager.

    Pass client= to inject a mock for tests.
    """
    def create(vault_id: str, definition: VaultDefinition) -> GcpSecretManagerProvider:
        return GcpSecretManagerProvider(vault_id, definition, client=client)

    return SecretVaultProviderFactory(provider=PROVIDER_NAME, create=create)
