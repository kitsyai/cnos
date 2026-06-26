"""Tests for CnosRuntime: load from projection JSON, read values, derived, to_object, to_env."""
from __future__ import annotations

import base64
import json
import os
import struct

import pytest

from cnos.env import Environment
from cnos.errors import CnosError
from cnos.exports import to_env, to_object, to_public_env
from cnos.loader import CnosOptions, load, load_projection
from cnos.runtime import new_runtime, _to_logical_key
from cnos.types import (
    SecretVaultProvider,
    SecretVaultProviderFactory,
    ToEnvOptions,
    ToPublicEnvOptions,
    VaultAuthConfig,
    VaultDefinition,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_projection(**overrides) -> bytes:
    base = {
        "version": 1,
        "workspace": "default",
        "profile": "base",
        "resolvedAt": "2024-01-01T00:00:00Z",
        "configHash": "abc123",
        "values": {"server.host": "localhost", "server.port": 5432, "debug": True},
        "derived": {},
        "secretRefs": {},
        "publicKeys": [],
        "meta": {
            "workspace": "default",
            "profile": "base",
            "cnos_version": "1.11.3",
        },
    }
    base.update(overrides)
    return json.dumps(base).encode()


def _make_runtime(**overrides) -> "CnosRuntime":
    return new_runtime(_make_projection(**overrides), Environment(), "/tmp/cnos-test-secrets", [])


# ---------------------------------------------------------------------------
# Load from projection bytes
# ---------------------------------------------------------------------------

class TestLoadProjection:
    def test_load_projection_bytes(self):
        rt = load_projection(_make_projection())
        assert rt is not None

    def test_load_raises_on_invalid_json(self):
        with pytest.raises(CnosError, match="parse server projection"):
            load_projection(b"not json")

    def test_load_raises_on_invalid_payload(self):
        with pytest.raises(CnosError, match="invalid server projection payload"):
            load_projection(json.dumps({"version": 1}).encode())

    def test_load_options_projection_data(self):
        opts = CnosOptions(projection_data=_make_projection())
        rt = load(opts)
        assert rt is not None


# ---------------------------------------------------------------------------
# Read values
# ---------------------------------------------------------------------------

class TestReadValues:
    def setup_method(self):
        self.rt = _make_runtime()

    def test_read_string(self):
        val, found = self.rt.read("value.server.host")
        assert found
        assert val == "localhost"

    def test_read_int(self):
        val, found = self.rt.read("value.server.port")
        assert found
        assert val == 5432

    def test_read_bool(self):
        val, found = self.rt.read("value.debug")
        assert found
        assert val is True

    def test_read_missing_key(self):
        val, found = self.rt.read("value.nonexistent")
        assert not found
        assert val is None

    def test_require_existing(self):
        val = self.rt.require("value.server.host")
        assert val == "localhost"

    def test_require_missing_raises(self):
        with pytest.raises(CnosError, match="missing config key"):
            self.rt.require("value.nonexistent")

    def test_read_or_existing(self):
        val = self.rt.read_or("value.server.host", "fallback")
        assert val == "localhost"

    def test_read_or_missing_fallback(self):
        val = self.rt.read_or("value.nonexistent", "fallback")
        assert val == "fallback"

    def test_value_shorthand(self):
        val, found = self.rt.value("server.host")
        assert found
        assert val == "localhost"

    def test_meta_profile(self):
        val, found = self.rt.meta("profile")
        assert found
        assert val == "base"

    def test_meta_workspace(self):
        val, found = self.rt.meta("workspace")
        assert found
        assert val == "default"

    def test_meta_cnos_version(self):
        val, found = self.rt.meta("cnos_version")
        assert found
        assert val == "1.11.3"


# ---------------------------------------------------------------------------
# Derived — template mode
# ---------------------------------------------------------------------------

class TestDerivedTemplate:
    def test_template_concat(self):
        rt = _make_runtime(
            values={"host": "db.example.com", "port": 5432},
            derived={
                "url": {
                    "expr": "postgresql://${value.host}:${value.port}/mydb",
                    "deps": ["value.host", "value.port"],
                    "runtimeRefs": [],
                }
            },
        )
        val, found = rt.read("value.url")
        assert found
        assert val == "postgresql://db.example.com:5432/mydb"


# ---------------------------------------------------------------------------
# Derived — expression mode
# ---------------------------------------------------------------------------

class TestDerivedExpression:
    def test_coalesce_expression(self):
        rt = _make_runtime(
            values={"a": None, "b": "fallback"},
            derived={
                "result": {
                    "expr": "coalesce(value.a, value.b)",
                    "deps": ["value.a", "value.b"],
                    "runtimeRefs": [],
                }
            },
        )
        val, found = rt.read("value.result")
        assert found
        assert val == "fallback"

    def test_when_expression(self):
        rt = _make_runtime(
            values={"env": "prod"},
            derived={
                "is_prod": {
                    "expr": "eq(value.env, 'prod')",
                    "deps": ["value.env"],
                    "runtimeRefs": [],
                }
            },
        )
        val, found = rt.read("value.is_prod")
        assert found
        assert val is True

    def test_concat_expression(self):
        rt = _make_runtime(
            values={"first": "hello", "second": " world"},
            derived={
                "greeting": {
                    "expr": "concat(value.first, value.second)",
                    "deps": ["value.first", "value.second"],
                    "runtimeRefs": [],
                }
            },
        )
        val, found = rt.read("value.greeting")
        assert found
        assert val == "hello world"

    def test_derived_caches_result(self):
        rt = _make_runtime(
            values={"x": 42},
            derived={
                "doubled": {
                    "expr": "concat(value.x, value.x)",
                    "deps": ["value.x"],
                    "runtimeRefs": [],
                }
            },
        )
        v1, _ = rt.read("value.doubled")
        v2, _ = rt.read("value.doubled")
        assert v1 == v2
        # After first eval, formula_cached should be True
        entry = rt._entries["value.doubled"]
        assert entry.formula_cached


# ---------------------------------------------------------------------------
# Secret resolution with mock provider
# ---------------------------------------------------------------------------

class MockSecretProvider(SecretVaultProvider):
    def __init__(self, secrets: dict):
        self._secrets = secrets

    def authenticate(self, auth: VaultAuthConfig) -> None:
        pass

    def batch_get(self, refs):
        return {ref: self._secrets[ref] for ref in refs if ref in self._secrets}

    def get(self, ref):
        return self._secrets.get(ref)


class TestSecretResolution:
    def test_secret_from_mock_provider(self):
        projection = json.dumps({
            "version": 1,
            "workspace": "default",
            "profile": "base",
            "resolvedAt": "2024-01-01T00:00:00Z",
            "configHash": "abc",
            "values": {},
            "derived": {},
            "secretRefs": {
                "db.password": {"ref": "my-db-pass", "vault": "mock-vault", "provider": "mock-provider"}
            },
            "vaults": {
                "mock-vault": {"provider": "mock-provider"}
            },
            "publicKeys": [],
            "meta": {"workspace": "default", "profile": "base", "cnos_version": "1.0.0"},
        }).encode()

        factory = SecretVaultProviderFactory(
            provider="mock-provider",
            create=lambda vault_id, definition: MockSecretProvider({"my-db-pass": "s3cret"}),
        )
        rt = new_runtime(projection, Environment(), "/tmp/test-secrets", [factory])
        val, found = rt.secret("db.password")
        assert found
        assert val == "s3cret"

    def test_secret_from_environment_provider(self):
        projection = json.dumps({
            "version": 1,
            "workspace": "default",
            "profile": "base",
            "resolvedAt": "2024-01-01T00:00:00Z",
            "configHash": "abc",
            "values": {},
            "derived": {},
            "secretRefs": {
                "api.key": {"ref": "MY_API_KEY", "vault": "env-vault", "provider": "environment"}
            },
            "vaults": {
                "env-vault": {"provider": "environment"}
            },
            "publicKeys": [],
            "meta": {"workspace": "default", "profile": "base", "cnos_version": "1.0.0"},
        }).encode()

        env = Environment({"MY_API_KEY": "env-secret-value"})
        rt = new_runtime(projection, env, "/tmp/test-secrets", [])
        val, found = rt.secret("api.key")
        assert found
        assert val == "env-secret-value"


# ---------------------------------------------------------------------------
# to_object
# ---------------------------------------------------------------------------

class TestToObject:
    def test_returns_nested_dict(self):
        rt = _make_runtime()
        obj = to_object(rt)
        assert "value" in obj
        assert obj["value"]["server"]["host"] == "localhost"
        assert obj["value"]["server"]["port"] == 5432

    def test_includes_meta(self):
        rt = _make_runtime()
        obj = to_object(rt)
        assert "meta" in obj
        assert obj["meta"]["profile"] == "base"

    def test_namespace_filter(self):
        from cnos.exports import to_namespace
        rt = _make_runtime()
        obj = to_namespace(rt, "value")
        assert "server" in obj
        assert obj["server"]["host"] == "localhost"
        assert "meta" not in obj  # filtered out


# ---------------------------------------------------------------------------
# to_env
# ---------------------------------------------------------------------------

class TestToEnv:
    def test_explicit_env_mapping(self):
        projection = json.dumps({
            "version": 1,
            "workspace": "default",
            "profile": "base",
            "resolvedAt": "2024-01-01T00:00:00Z",
            "configHash": "abc",
            "values": {"server.port": 8080},
            "derived": {},
            "secretRefs": {},
            "publicKeys": [],
            "meta": {"workspace": "default", "profile": "base", "cnos_version": "1.0.0"},
        }).encode()

        rt = new_runtime(projection, Environment(), "/tmp", [])
        # Without env_mapping configured, to_env returns empty
        result = to_env(rt)
        assert isinstance(result, dict)

    def test_to_public_env(self):
        projection = json.dumps({
            "version": 1,
            "workspace": "default",
            "profile": "base",
            "resolvedAt": "2024-01-01T00:00:00Z",
            "configHash": "abc",
            "values": {"app.name": "myapp"},
            "derived": {},
            "secretRefs": {},
            "publicKeys": ["app.name"],
            "meta": {"workspace": "default", "profile": "base", "cnos_version": "1.0.0"},
        }).encode()

        rt = new_runtime(projection, Environment(), "/tmp", [])
        result = to_public_env(rt)
        assert "APP_NAME" in result
        assert result["APP_NAME"] == "myapp"

    def test_to_public_env_with_prefix(self):
        projection = json.dumps({
            "version": 1,
            "workspace": "default",
            "profile": "base",
            "resolvedAt": "2024-01-01T00:00:00Z",
            "configHash": "abc",
            "values": {"app.name": "myapp"},
            "derived": {},
            "secretRefs": {},
            "publicKeys": ["app.name"],
            "meta": {"workspace": "default", "profile": "base", "cnos_version": "1.0.0"},
        }).encode()

        rt = new_runtime(projection, Environment(), "/tmp", [])
        result = to_public_env(rt, ToPublicEnvOptions(prefix="NEXT_PUBLIC_"))
        assert "NEXT_PUBLIC_APP_NAME" in result


class TestToLogicalKeyIdempotency:
    @pytest.mark.parametrize("namespace,input_path,expected", [
        ("value", "server.port", "value.server.port"),
        ("value", "value.server.port", "value.server.port"),   # already prefixed
        ("secret", "db.password", "secret.db.password"),
        ("secret", "secret.db.password", "secret.db.password"),  # already prefixed
        ("meta", "workspace", "meta.workspace"),
        ("meta", "meta.workspace", "meta.workspace"),  # already prefixed
    ])
    def test_idempotency(self, namespace, input_path, expected):
        assert _to_logical_key(namespace, input_path) == expected

    def test_secret_accepts_fully_qualified_key(self):
        rt = new_runtime(json.dumps({
            "version": 1, "workspace": "base", "profile": "local",
            "resolvedAt": "2024-01-01T00:00:00Z", "configHash": "x",
            "values": {}, "derived": {},
            "secretRefs": {"db.password": {"provider": "environment", "ref": "DB_PASS", "vault": "v"}},
            "publicKeys": [], "runtimeNamespaces": [],
            "meta": {"workspace": "base", "profile": "local", "cnos_version": "1.11.3"},
        }).encode(), Environment({"DB_PASS": "s3cr3t"}), "/tmp", [])
        val1, _ = rt.secret("db.password")
        val2, _ = rt.secret("secret.db.password")
        assert val1 == val2 == "s3cr3t"
