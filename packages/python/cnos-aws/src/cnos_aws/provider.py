"""AWS Secrets Manager CNOS vault provider — mirrors Go's awssecretsmanager.go."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from cnos.errors import CnosError
from cnos.types import (
    SecretVaultProvider,
    SecretVaultProviderFactory,
    VaultAuthConfig,
    VaultDefinition,
)

PROVIDER_NAME = "aws-secrets-manager"


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


class AwsSecretsManagerProvider(SecretVaultProvider):
    """AWS Secrets Manager provider. Supports injecting a mock client for tests."""

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
            "region": _string_config(config, "region"),
            "endpoint": _string_config(config, "endpoint"),
            "version_id": _first_string_config(config, "versionId", "version"),
            "version_stage": _string_config(config, "versionStage"),
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
            import boto3
        except ImportError as exc:
            raise CnosError("cnos-aws: boto3 is required. Install with: pip install boto3") from exc
        kwargs: Dict[str, Any] = {}
        if self._config["region"]:
            kwargs["region_name"] = self._config["region"]
        client = boto3.client("secretsmanager", **kwargs)
        if self._config["endpoint"]:
            client = boto3.client(
                "secretsmanager",
                endpoint_url=self._config["endpoint"],
                **{k: v for k, v in kwargs.items()},
            )
        return client

    def batch_get(self, refs: List[str]) -> Dict[str, Any]:
        unique = _unique_sorted(refs)
        # If version params set, fall back to individual gets
        if self._config["version_id"] or self._config["version_stage"]:
            return self._get_each(unique)

        # Try BatchGetSecretValue
        external_to_logical: Dict[str, str] = {}
        secret_ids: List[str] = []
        for ref in unique:
            external = self._external_secret_id(ref)
            external_to_logical[external] = ref
            secret_ids.append(external)

        try:
            response = self._client.batch_get_secret_value(SecretIdList=secret_ids)
        except Exception as exc:
            if self._is_resource_not_found(exc) or self._is_operation_not_supported(exc):
                return self._get_each(unique)
            raise CnosError(f"cnos-aws: batch_get_secret_value failed: {exc}") from exc

        # Check batch errors
        for err in response.get("Errors") or []:
            if err.get("ErrorCode") == "ResourceNotFoundException":
                continue
            code = err.get("ErrorCode", "UnknownError")
            msg = err.get("Message", "")
            secret_id = err.get("SecretId", "")
            raise CnosError(
                f"AWS Secrets Manager batch read failed for {secret_id!r}: {code}: {msg}"
            )

        resolved: Dict[str, Any] = {}
        for secret in response.get("SecretValues") or []:
            ref = self._resolve_output_ref(secret, external_to_logical)
            value = self._decode_secret_value(secret)
            if ref and value is not None:
                resolved[ref] = value
        return resolved

    def get(self, ref: str) -> Optional[Any]:
        value = self._get_one(ref)
        return value

    def _get_each(self, refs: List[str]) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        for ref in refs:
            val = self._get_one(ref)
            if val is not None:
                result[ref] = val
        return result

    def _get_one(self, ref: str) -> Optional[str]:
        kwargs: Dict[str, Any] = {"SecretId": self._external_secret_id(ref)}
        if self._config["version_id"]:
            kwargs["VersionId"] = self._config["version_id"]
        if self._config["version_stage"]:
            kwargs["VersionStage"] = self._config["version_stage"]
        try:
            response = self._client.get_secret_value(**kwargs)
        except Exception as exc:
            if self._is_resource_not_found(exc):
                return None
            raise CnosError(f"cnos-aws: get_secret_value failed for {ref!r}: {exc}") from exc
        return self._decode_get_secret_value(response)

    def _external_secret_id(self, ref: str) -> str:
        """Map logical ref to external secret ID via definition.mapping."""
        mapping = self._definition.mapping or {}
        for external, logical in mapping.items():
            if logical == ref:
                return external
        return ref

    def _logical_ref_for_external(self, secret_id: str) -> str:
        mapping = self._definition.mapping or {}
        return mapping.get(secret_id, secret_id)

    def _resolve_output_ref(self, secret: Dict[str, Any], external_to_logical: Dict[str, str]) -> str:
        arn = secret.get("ARN") or ""
        if arn and arn in external_to_logical:
            return external_to_logical[arn]
        name = secret.get("Name") or ""
        if name:
            if name in external_to_logical:
                return external_to_logical[name]
            return self._logical_ref_for_external(name)
        return ""

    @staticmethod
    def _decode_secret_value(secret: Dict[str, Any]) -> Optional[str]:
        if secret.get("SecretString") is not None:
            return secret["SecretString"]
        if secret.get("SecretBinary") is not None:
            return secret["SecretBinary"].decode("utf-8", errors="replace")
        return None

    @staticmethod
    def _decode_get_secret_value(response: Dict[str, Any]) -> Optional[str]:
        if response.get("SecretString") is not None:
            return response["SecretString"]
        if response.get("SecretBinary") is not None:
            return response["SecretBinary"].decode("utf-8", errors="replace")
        return None

    @staticmethod
    def _is_resource_not_found(exc: Exception) -> bool:
        cls_name = type(exc).__name__
        if "ResourceNotFoundException" in cls_name:
            return True
        code = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
        return code == "ResourceNotFoundException"

    @staticmethod
    def _is_operation_not_supported(exc: Exception) -> bool:
        cls_name = type(exc).__name__
        return "InvalidRequestException" in cls_name or "OperationNotPermitted" in cls_name


def factory(client: Any = None) -> SecretVaultProviderFactory:
    """Return a SecretVaultProviderFactory for AWS Secrets Manager.

    Pass client= to inject a mock for tests.
    """
    def create(vault_id: str, definition: VaultDefinition) -> AwsSecretsManagerProvider:
        return AwsSecretsManagerProvider(vault_id, definition, client=client)

    return SecretVaultProviderFactory(provider=PROVIDER_NAME, create=create)
