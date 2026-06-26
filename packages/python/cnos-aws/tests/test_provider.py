"""Tests for the AWS Secrets Manager provider."""
from __future__ import annotations

import pytest

from cnos.types import VaultAuthConfig, VaultAuthDefinition, VaultDefinition
from cnos_aws.provider import AwsSecretsManagerProvider, PROVIDER_NAME


# ---------------------------------------------------------------------------
# Mock client
# ---------------------------------------------------------------------------

class MockAwsClient:
    def __init__(self, secrets: dict, raise_on_batch: bool = False, not_found: set = None):
        self._secrets = secrets
        self._raise_on_batch = raise_on_batch
        self._not_found = not_found or set()

    def batch_get_secret_value(self, **kwargs):
        if self._raise_on_batch:
            raise _ResourceNotFoundException("not found")
        secret_ids = kwargs.get("SecretIdList", [])
        values = []
        errors = []
        for sid in secret_ids:
            if sid in self._not_found:
                errors.append({"ErrorCode": "ResourceNotFoundException", "SecretId": sid})
            elif sid in self._secrets:
                values.append({"Name": sid, "SecretString": self._secrets[sid]})
        return {"SecretValues": values, "Errors": errors}

    def get_secret_value(self, **kwargs):
        sid = kwargs.get("SecretId", "")
        if sid in self._not_found:
            raise _ResourceNotFoundException(sid)
        if sid in self._secrets:
            return {"SecretString": self._secrets[sid]}
        raise _ResourceNotFoundException(sid)


class _ResourceNotFoundException(Exception):
    def __init__(self, msg=""):
        super().__init__(msg)
        self.response = {"Error": {"Code": "ResourceNotFoundException"}}


def _make_provider(secrets: dict, **kwargs) -> AwsSecretsManagerProvider:
    definition = VaultDefinition(
        provider=PROVIDER_NAME,
        auth=VaultAuthDefinition(method="iam"),
        mapping={},
    )
    client = MockAwsClient(secrets, **kwargs)
    p = AwsSecretsManagerProvider("test-vault", definition, client=client)
    p._authenticated = True
    return p


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestAuthenticate:
    def test_iam_auth_accepted(self):
        p = _make_provider({})
        p._authenticated = False
        p.authenticate(VaultAuthConfig(method="iam"))
        assert p._authenticated

    def test_environment_auth_accepted(self):
        p = _make_provider({})
        p._authenticated = False
        p.authenticate(VaultAuthConfig(method="environment"))
        assert p._authenticated

    def test_wrong_auth_raises(self):
        p = _make_provider({})
        p._authenticated = False
        with pytest.raises(Exception, match="iam authentication"):
            p.authenticate(VaultAuthConfig(method="token", token="tok"))


class TestBatchGet:
    def test_returns_secrets(self):
        p = _make_provider({"my-secret": "value123"})
        result = p.batch_get(["my-secret"])
        assert result == {"my-secret": "value123"}

    def test_missing_secret_not_in_result(self):
        p = _make_provider({}, not_found={"missing-secret"})
        result = p.batch_get(["missing-secret"])
        assert "missing-secret" not in result

    def test_multiple_secrets(self):
        p = _make_provider({"s1": "v1", "s2": "v2"})
        result = p.batch_get(["s1", "s2"])
        assert result == {"s1": "v1", "s2": "v2"}

    def test_deduplicates_refs(self):
        p = _make_provider({"s1": "v1"})
        result = p.batch_get(["s1", "s1", "s1"])
        assert result == {"s1": "v1"}


class TestGet:
    def test_existing_secret(self):
        p = _make_provider({"sec": "val"})
        assert p.get("sec") == "val"

    def test_missing_returns_none(self):
        p = _make_provider({}, not_found={"missing"})
        assert p.get("missing") is None


class TestMapping:
    def test_external_mapping(self):
        definition = VaultDefinition(
            provider=PROVIDER_NAME,
            auth=VaultAuthDefinition(method="iam"),
            mapping={"arn:aws:secretsmanager:us-east-1:123:secret:prod/db": "db.password"},
        )
        client = MockAwsClient({"arn:aws:secretsmanager:us-east-1:123:secret:prod/db": "secret!"})
        p = AwsSecretsManagerProvider("v", definition, client=client)
        p._authenticated = True
        result = p.batch_get(["db.password"])
        assert result.get("db.password") == "secret!"


class TestFallbackToIndividualGet:
    def test_fallback_on_batch_error(self):
        p = _make_provider({"sec": "val"}, raise_on_batch=True)
        result = p.batch_get(["sec"])
        assert result.get("sec") == "val"


class TestProviderName:
    def test_provider_name_constant(self):
        assert PROVIDER_NAME == "aws-secrets-manager"
