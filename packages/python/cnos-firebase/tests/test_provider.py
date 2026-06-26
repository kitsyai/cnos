"""Tests for the Firebase Secrets provider.

FirebaseSecretsProvider is a thin wrapper over GcpSecretManagerProvider;
all functional logic is tested in cnos-gcp. These tests verify:
  - the provider name constant is "firebase-secrets"
  - delegation to the GCP provider works end-to-end
  - factory() returns a usable SecretVaultProviderFactory
"""
from __future__ import annotations

from typing import Any, Dict, Optional

import pytest

from cnos.types import VaultAuthConfig, VaultAuthDefinition, VaultDefinition
from cnos_firebase.provider import FirebaseSecretsProvider, PROVIDER_NAME, factory


# ---------------------------------------------------------------------------
# Mock GCP Secret Manager client (reused from cnos-gcp tests)
# ---------------------------------------------------------------------------

class _NotFoundError(Exception):
    pass


class MockGcpClient:
    def __init__(self, secrets: Dict[str, str], project_id: str = "test-project") -> None:
        self._secrets = secrets
        self.project_id = project_id

    def access_secret_version(self, name: str) -> str:
        for key, val in self._secrets.items():
            if key in name:
                return val
        raise _NotFoundError(f"not found: {name}")


def _make_provider(
    secrets: Dict[str, str] = None,
    project_id: str = "test-project",
    mapping: dict = None,
) -> FirebaseSecretsProvider:
    definition = VaultDefinition(
        provider=PROVIDER_NAME,
        auth=VaultAuthDefinition(method="iam", config={"projectId": project_id}),
        mapping=mapping or {},
    )
    client = MockGcpClient(secrets or {}, project_id=project_id)
    p = FirebaseSecretsProvider("test-vault", definition, client=client)
    p._delegate._authenticated = True
    return p


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestProviderName:
    def test_constant(self):
        assert PROVIDER_NAME == "firebase-secrets"

    def test_factory_provider_name(self):
        f = factory()
        assert f.provider == "firebase-secrets"


class TestAuthenticate:
    def test_iam_accepted(self):
        p = _make_provider()
        p._delegate._authenticated = False
        p.authenticate(VaultAuthConfig(method="iam"))
        assert p._delegate._authenticated

    def test_environment_accepted(self):
        p = _make_provider()
        p._delegate._authenticated = False
        p.authenticate(VaultAuthConfig(method="environment"))
        assert p._delegate._authenticated

    def test_wrong_method_raises(self):
        p = _make_provider()
        p._delegate._authenticated = False
        with pytest.raises(Exception, match="iam authentication"):
            p.authenticate(VaultAuthConfig(method="token", token="t"))


class TestBatchGet:
    def test_delegates_to_gcp(self):
        p = _make_provider({"my-secret": "firebase-value"})
        result = p.batch_get(["my-secret"])
        assert result == {"my-secret": "firebase-value"}

    def test_not_found_excluded(self):
        p = _make_provider({})
        result = p.batch_get(["missing"])
        assert "missing" not in result

    def test_multiple_secrets(self):
        p = _make_provider({"s1": "v1", "s2": "v2"})
        result = p.batch_get(["s1", "s2"])
        assert result == {"s1": "v1", "s2": "v2"}


class TestGet:
    def test_existing_secret(self):
        p = _make_provider({"sec": "val"})
        assert p.get("sec") == "val"

    def test_missing_returns_none(self):
        p = _make_provider({})
        assert p.get("missing") is None


class TestMapping:
    def test_external_mapping(self):
        p = _make_provider(
            {"firebase-project/external-name": "mapped-value"},
            mapping={"firebase-project/external-name": "logical.key"},
        )
        result = p.batch_get(["logical.key"])
        assert result.get("logical.key") == "mapped-value"


class TestFactory:
    def test_factory_creates_provider(self):
        client = MockGcpClient({"key": "val"})
        definition = VaultDefinition(
            provider=PROVIDER_NAME,
            auth=VaultAuthDefinition(method="iam", config={"projectId": "proj"}),
        )
        f = factory(client=client)
        p = f.create("my-vault", definition)
        assert isinstance(p, FirebaseSecretsProvider)
        assert f.provider == PROVIDER_NAME
