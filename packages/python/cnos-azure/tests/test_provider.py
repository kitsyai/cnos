"""Tests for the Azure Key Vault provider."""
from __future__ import annotations

from typing import Any, Dict, Optional

import pytest

from cnos.types import VaultAuthConfig, VaultAuthDefinition, VaultDefinition
from cnos_azure.provider import (
    AzureKeyVaultProvider,
    PROVIDER_NAME,
    _parse_secret_ref,
    _origin_for_url,
)


# ---------------------------------------------------------------------------
# Mock client — replaces azure.keyvault.secrets.SecretClient
# ---------------------------------------------------------------------------

class MockSecretClient:
    """Mimics azure.keyvault.secrets.SecretClient.get_secret()."""

    def __init__(self, secrets: Dict[str, str], not_found: Optional[set] = None) -> None:
        self._secrets = secrets  # name -> value
        self._not_found = not_found or set()

    def get_secret(self, name: str, version: str = "") -> str:
        if name in self._not_found:
            raise _FakeResourceNotFoundError(name)
        if name in self._secrets:
            return self._secrets[name]
        raise _FakeResourceNotFoundError(name)


class MockKeyVaultSecret:
    def __init__(self, value: str) -> None:
        self.value = value


class _FakeResourceNotFoundError(Exception):
    """Mimics azure.core.exceptions.ResourceNotFoundError."""
    status_code = 404

    def __init__(self, name: str) -> None:
        super().__init__(f"Secret {name!r} not found")


def _make_provider(
    secrets: Dict[str, str] = None,
    not_found: set = None,
    vault_url: str = "https://myvault.vault.azure.net",
    version: str = "",
    tenant_id: str = "",
    client_id: str = "",
    mapping: dict = None,
) -> AzureKeyVaultProvider:
    config: Dict[str, Any] = {"vaultUrl": vault_url}
    if version:
        config["version"] = version
    if tenant_id:
        config["tenantId"] = tenant_id
    if client_id:
        config["clientId"] = client_id
    definition = VaultDefinition(
        provider=PROVIDER_NAME,
        auth=VaultAuthDefinition(method="iam", config=config),
        mapping=mapping or {},
    )
    client = MockSecretClient(secrets or {}, not_found)
    p = AzureKeyVaultProvider("test-vault", definition, client=client)
    p._authenticated = True
    return p


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestAuthenticate:
    def test_iam_accepted(self):
        p = _make_provider()
        p._authenticated = False
        # Provide a pre-built client so it won't try to import azure SDKs.
        p.authenticate(VaultAuthConfig(method="iam"))
        assert p._authenticated

    def test_environment_accepted(self):
        p = _make_provider()
        p._authenticated = False
        p.authenticate(VaultAuthConfig(method="environment"))
        assert p._authenticated

    def test_wrong_method_raises(self):
        p = _make_provider()
        p._authenticated = False
        with pytest.raises(Exception, match="iam authentication"):
            p.authenticate(VaultAuthConfig(method="token"))


class TestBatchGet:
    def test_returns_secrets(self):
        p = _make_provider({"db-password": "hunter2", "api-key": "abc123"})
        result = p.batch_get(["db-password", "api-key"])
        assert result["db-password"] == "hunter2"
        assert result["api-key"] == "abc123"

    def test_decodes_key_vault_secret_value(self):
        p = _make_provider({"db-password": MockKeyVaultSecret("hunter2")})
        result = p.batch_get(["db-password"])
        assert result["db-password"] == "hunter2"

    def test_not_found_excluded(self):
        p = _make_provider(not_found={"missing"})
        result = p.batch_get(["missing"])
        assert "missing" not in result

    def test_deduplicates_refs(self):
        p = _make_provider({"s": "v"})
        result = p.batch_get(["s", "s"])
        assert result == {"s": "v"}

    def test_empty_refs_returns_empty(self):
        p = _make_provider({})
        result = p.batch_get([])
        assert result == {}


class TestGet:
    def test_returns_existing(self):
        p = _make_provider({"my-secret": "secret-value"})
        assert p.get("my-secret") == "secret-value"

    def test_returns_none_for_missing(self):
        p = _make_provider(not_found={"missing"})
        assert p.get("missing") is None


class TestFullUrlParsing:
    def test_simple_name_parsed(self):
        parsed = _parse_secret_ref("my-secret")
        assert parsed.name == "my-secret"
        assert parsed.version == ""
        assert parsed.full_url is False

    def test_full_url_parsed(self):
        parsed = _parse_secret_ref("https://myvault.vault.azure.net/secrets/my-secret")
        assert parsed.name == "my-secret"
        assert parsed.version == ""
        assert parsed.full_url is True

    def test_full_url_with_version_parsed(self):
        parsed = _parse_secret_ref("https://myvault.vault.azure.net/secrets/my-secret/abc123")
        assert parsed.name == "my-secret"
        assert parsed.version == "abc123"
        assert parsed.full_url is True

    def test_invalid_url_path_raises(self):
        with pytest.raises(Exception, match="/secrets/"):
            _parse_secret_ref("https://myvault.vault.azure.net/not-secrets/my-secret")

    def test_empty_name_raises(self):
        with pytest.raises(Exception):
            _parse_secret_ref("")

    def test_origin_extracted(self):
        parsed = _parse_secret_ref("https://myvault.vault.azure.net/secrets/my-secret")
        assert parsed.origin == "https://myvault.vault.azure.net"

    def test_origin_lowercase(self):
        parsed = _parse_secret_ref("https://MyVault.VAULT.azure.net/secrets/my-secret")
        assert parsed.origin == "https://myvault.vault.azure.net"


class TestMapping:
    def test_logical_to_external_mapping(self):
        p = _make_provider(
            {"external-secret-name": "mapped-value"},
            mapping={"external-secret-name": "logical.db.password"},
        )
        result = p.batch_get(["logical.db.password"])
        assert result.get("logical.db.password") == "mapped-value"

    def test_unmapped_ref_used_directly(self):
        p = _make_provider(
            {"direct-name": "direct-value"},
            mapping={"other-secret": "other.key"},
        )
        result = p.batch_get(["direct-name"])
        assert result.get("direct-name") == "direct-value"


class Test404ReturnsNone:
    def test_not_found_returns_none(self):
        p = _make_provider(not_found={"gone-secret"})
        assert p.get("gone-secret") is None

    def test_other_errors_propagate(self):
        class BrokenClient:
            def get_secret(self, name, version=""):
                raise RuntimeError("network timeout")

        definition = VaultDefinition(
            provider=PROVIDER_NAME,
            auth=VaultAuthDefinition(method="iam", config={"vaultUrl": "https://v.vault.azure.net"}),
            mapping={},
        )
        p = AzureKeyVaultProvider("v", definition, client=BrokenClient())
        p._authenticated = True
        with pytest.raises(Exception, match="get_secret failed"):
            p.get("any-secret")


class TestOriginForUrl:
    def test_basic(self):
        assert _origin_for_url("https://vault.azure.net") == "https://vault.azure.net"

    def test_lowercase(self):
        assert _origin_for_url("HTTPS://Vault.Azure.Net") == "https://vault.azure.net"

    def test_empty(self):
        assert _origin_for_url("") == ""


class TestProviderName:
    def test_constant(self):
        assert PROVIDER_NAME == "azure-key-vault"
