"""Tests for the GCP Secret Manager provider."""
from __future__ import annotations

import pytest

from cnos.types import VaultAuthConfig, VaultAuthDefinition, VaultDefinition
from cnos_gcp.provider import GcpSecretManagerProvider, PROVIDER_NAME


class _NotFoundError(Exception):
    pass


class MockGcpClient:
    def __init__(self, secrets: dict, project_id: str = "test-project"):
        self._secrets = secrets
        self.project_id = project_id

    def access_secret_version(self, name: str) -> str:
        # Find matching secret by the last segment before /versions/
        for key, val in self._secrets.items():
            if key in name:
                return val
        raise _NotFoundError(f"not found: {name}")


class MockGcpPayload:
    def __init__(self, data: bytes) -> None:
        self.data = data


class MockGcpResponse:
    def __init__(self, data: bytes) -> None:
        self.payload = MockGcpPayload(data)


def _make_provider(secrets: dict, project_id: str = "test-project", **config) -> GcpSecretManagerProvider:
    auth_config = {"projectId": project_id}
    auth_config.update(config)
    definition = VaultDefinition(
        provider=PROVIDER_NAME,
        auth=VaultAuthDefinition(method="iam", config=auth_config),
        mapping={},
    )
    client = MockGcpClient(secrets, project_id=project_id)
    p = GcpSecretManagerProvider("test-vault", definition, client=client)
    p._authenticated = True
    return p


class TestAuthenticate:
    def test_iam_accepted(self):
        p = _make_provider({})
        p._authenticated = False
        p.authenticate(VaultAuthConfig(method="iam"))
        assert p._authenticated

    def test_environment_accepted(self):
        p = _make_provider({})
        p._authenticated = False
        p.authenticate(VaultAuthConfig(method="environment"))
        assert p._authenticated

    def test_wrong_method_raises(self):
        p = _make_provider({})
        p._authenticated = False
        with pytest.raises(Exception, match="iam authentication"):
            p.authenticate(VaultAuthConfig(method="token", token="t"))


class TestBatchGet:
    def test_returns_secrets(self):
        p = _make_provider({"my-secret": "value123"})
        result = p.batch_get(["my-secret"])
        assert result == {"my-secret": "value123"}

    def test_decodes_secret_manager_response_payload_data(self):
        p = _make_provider({"my-secret": MockGcpResponse(b"value123")})
        result = p.batch_get(["my-secret"])
        assert result == {"my-secret": "value123"}

    def test_not_found_excluded(self):
        p = _make_provider({})
        result = p.batch_get(["missing-secret"])
        assert "missing-secret" not in result

    def test_multiple_secrets(self):
        p = _make_provider({"s1": "v1", "s2": "v2"})
        result = p.batch_get(["s1", "s2"])
        assert result == {"s1": "v1", "s2": "v2"}

    def test_deduplicates(self):
        p = _make_provider({"s1": "v1"})
        result = p.batch_get(["s1", "s1"])
        assert result == {"s1": "v1"}


class TestGet:
    def test_existing(self):
        p = _make_provider({"sec": "val"})
        assert p.get("sec") == "val"

    def test_missing_returns_none(self):
        p = _make_provider({})
        assert p.get("missing") is None


class TestVersionName:
    def test_builds_correct_name(self):
        p = _make_provider({}, project_id="my-project")
        name = p._version_name_for_ref("my-secret")
        assert name == "projects/my-project/secrets/my-secret/versions/latest"

    def test_custom_version(self):
        definition = VaultDefinition(
            provider=PROVIDER_NAME,
            auth=VaultAuthDefinition(method="iam", config={"projectId": "proj", "version": "3"}),
        )
        p = GcpSecretManagerProvider("v", definition, client=MockGcpClient({}))
        name = p._version_name_for_ref("sec")
        assert name.endswith("/versions/3")

    def test_full_name_passthrough(self):
        p = _make_provider({})
        full = "projects/proj/secrets/sec/versions/latest"
        assert p._version_name_for_ref(full) == full

    def test_location_included(self):
        definition = VaultDefinition(
            provider=PROVIDER_NAME,
            auth=VaultAuthDefinition(method="iam", config={"projectId": "proj", "location": "us-east1"}),
        )
        p = GcpSecretManagerProvider("v", definition, client=MockGcpClient({}))
        name = p._version_name_for_ref("sec")
        assert "locations/us-east1" in name


class TestMapping:
    def test_external_mapping(self):
        definition = VaultDefinition(
            provider=PROVIDER_NAME,
            auth=VaultAuthDefinition(method="iam", config={"projectId": "proj"}),
            mapping={"external-name": "logical-name"},
        )
        p = GcpSecretManagerProvider("v", definition, client=MockGcpClient({"external-name": "secret!"}))
        p._authenticated = True
        result = p.batch_get(["logical-name"])
        assert result.get("logical-name") == "secret!"


class TestProviderName:
    def test_constant(self):
        assert PROVIDER_NAME == "gcp-secret-manager"
