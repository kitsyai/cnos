"""Tests for the HashiCorp Vault provider."""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import pytest

from cnos.types import VaultAuthConfig, VaultAuthDefinition, VaultDefinition
from cnos_hashicorp.provider import (
    HashiCorpVaultProvider,
    PROVIDER_NAME,
    _parse_vault_ref,
    _decode_vault_value,
    _join_path,
)


# ---------------------------------------------------------------------------
# Mock client — matches the interface expected by provider._client_read
# ---------------------------------------------------------------------------

class MockHvacClient:
    def __init__(self, kv_data: dict, not_found: set = None, version: int = 2):
        self._kv_data = kv_data  # path -> dict of fields
        self._not_found = not_found or set()
        self._version = version
        self.token = ""

    def read(self, path: str, token: str, namespace: str) -> Tuple[Optional[Dict], int]:
        for key in self._not_found:
            if key in path:
                return None, 404
        for key, val in self._kv_data.items():
            if key in path:
                if self._version == 2:
                    return {"data": val}, 200
                return val, 200
        return None, 404


def _make_provider(
    kv_data: dict,
    not_found: set = None,
    mapping: dict = None,
    version: int = 2,
    kv_path: str = "",
) -> HashiCorpVaultProvider:
    config: Dict[str, Any] = {"version": version}
    if kv_path:
        config["path"] = kv_path
    definition = VaultDefinition(
        provider=PROVIDER_NAME,
        auth=VaultAuthDefinition(method="token", config=config),
        mapping=mapping or {},
    )
    client = MockHvacClient(kv_data, not_found, version)
    p = HashiCorpVaultProvider("test-vault", definition, client=client)
    p._token = "test-token"
    p._authenticated = True
    return p


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestAuthenticate:
    def test_token_accepted(self):
        p = _make_provider({})
        p._authenticated = False
        p.authenticate(VaultAuthConfig(method="token", token="mytoken"))
        assert p._authenticated

    def test_wrong_method_raises(self):
        p = _make_provider({})
        p._authenticated = False
        with pytest.raises(Exception, match="token authentication"):
            p.authenticate(VaultAuthConfig(method="iam"))

    def test_empty_token_raises(self):
        p = _make_provider({})
        p._authenticated = False
        with pytest.raises(Exception, match="token authentication"):
            p.authenticate(VaultAuthConfig(method="token", token=""))


class TestParseVaultRef:
    def test_no_field_defaults_to_value(self):
        parsed = _parse_vault_ref("my/secret")
        assert parsed.path == "my/secret"
        assert parsed.field == "value"
        assert parsed.explicit_field is False

    def test_explicit_field(self):
        parsed = _parse_vault_ref("my/secret#password")
        assert parsed.path == "my/secret"
        assert parsed.field == "password"
        assert parsed.explicit_field is True

    def test_empty_field_defaults_to_value(self):
        parsed = _parse_vault_ref("my/secret#")
        assert parsed.field == "value"

    def test_uses_last_hash(self):
        parsed = _parse_vault_ref("my#path/secret#field")
        assert parsed.field == "field"
        assert parsed.path == "my#path/secret"


class TestDecodeVaultValue:
    def test_returns_named_field(self):
        data = {"value": "secret", "other": "x"}
        result = _decode_vault_value(data, "value", False)
        assert result == "secret"

    def test_explicit_field(self):
        data = {"password": "hunter2"}
        result = _decode_vault_value(data, "password", True)
        assert result == "hunter2"

    def test_single_primitive_fallback(self):
        data = {"token": "abc123"}
        result = _decode_vault_value(data, "value", False)
        assert result == "abc123"

    def test_multiple_fields_no_explicit_returns_none(self):
        data = {"a": "1", "b": "2"}
        result = _decode_vault_value(data, "value", False)
        assert result is None

    def test_none_data(self):
        result = _decode_vault_value(None, "value", False)
        assert result is None


class TestBatchGet:
    def test_returns_secret(self):
        p = _make_provider({"my-secret": {"value": "secret123"}})
        result = p.batch_get(["my-secret"])
        assert result == {"my-secret": "secret123"}

    def test_not_found_excluded(self):
        p = _make_provider({}, not_found={"missing"})
        result = p.batch_get(["missing"])
        assert "missing" not in result

    def test_multiple_secrets(self):
        p = _make_provider({"s1": {"value": "v1"}, "s2": {"value": "v2"}})
        result = p.batch_get(["s1", "s2"])
        assert result["s1"] == "v1"
        assert result["s2"] == "v2"

    def test_deduplicates(self):
        p = _make_provider({"s1": {"value": "v1"}})
        result = p.batch_get(["s1", "s1"])
        assert result == {"s1": "v1"}


class TestGet:
    def test_existing(self):
        p = _make_provider({"sec": {"value": "val"}})
        assert p.get("sec") == "val"

    def test_missing_returns_none(self):
        p = _make_provider({}, not_found={"missing"})
        assert p.get("missing") is None


class TestKvVersion:
    def test_v2_wraps_data(self):
        p = _make_provider({"sec": {"value": "v2-secret"}}, version=2)
        result = p.batch_get(["sec"])
        assert result.get("sec") == "v2-secret"

    def test_v1_no_wrapping(self):
        p = _make_provider({"sec": {"value": "v1-secret"}}, version=1)
        result = p.batch_get(["sec"])
        assert result.get("sec") == "v1-secret"

    def test_read_path_v2(self):
        p = _make_provider({}, version=2)
        path = p._read_path("my/secret")
        assert "data" in path

    def test_read_path_v1(self):
        p = _make_provider({}, version=1)
        path = p._read_path("my/secret")
        assert "data" not in path


class TestMapping:
    def test_external_mapping(self):
        p = _make_provider(
            {"external-path": {"value": "mapped!"}},
            mapping={"external-path": "logical-name"},
        )
        result = p.batch_get(["logical-name"])
        assert result.get("logical-name") == "mapped!"


class TestJoinPath:
    def test_basic(self):
        assert _join_path("a", "b", "c") == "a/b/c"

    def test_strips_slashes(self):
        assert _join_path("/a/", "/b/") == "a/b"

    def test_empty_segments_skipped(self):
        assert _join_path("a", "", "b") == "a/b"


class TestProviderName:
    def test_constant(self):
        assert PROVIDER_NAME == "hashicorp-vault"
