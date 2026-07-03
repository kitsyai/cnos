"""Singleton / module-level API contract tests.

Covers all 15 methods in the contract:
  ready, read, require, read_or, value, secret, meta,
  set_default_runtime, default_runtime, reset_default_runtime,
  to_object, to_public_env, format, refresh_secrets, refresh_secret

Also covers the library composition model:
  root → libA → libB → libC → libD, libE → libF
  Only the root calls set_default_runtime / ready.
"""
from __future__ import annotations

import json
from typing import Any

import pytest

import cnos
from cnos.errors import CnosError
from cnos.loader import CnosOptions, load_projection
from cnos.types import ToPublicEnvOptions


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_MINIMAL = json.dumps({
    "version": 1,
    "workspace": "base",
    "profile": "local",
    "resolvedAt": "2024-01-01T00:00:00Z",
    "configHash": "abc123",
    "values": {
        "server.port": 3000,
        "app.name": "cnos-python",
    },
    "derived": {
        "app.effectiveHost": {
            "expr": "coalesce(request.headers.host, 'default.host')",
            "deps": [],
            "runtimeRefs": ["request.headers.host"],
        }
    },
    "secretRefs": {},
    "publicKeys": ["app.name"],
    "runtimeNamespaces": ["request"],
    "meta": {
        "workspace": "base",
        "profile": "local",
        "cnos_version": "1.14.0",
    },
}).encode()


def _make_runtime():
    return load_projection(_MINIMAL)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def reset_singleton():
    """Guarantee a clean singleton before and after every test."""
    cnos.reset_default_runtime()
    yield
    cnos.reset_default_runtime()


# ---------------------------------------------------------------------------
# Tests: lifecycle — set_default_runtime / default_runtime / reset_default_runtime
# ---------------------------------------------------------------------------

def test_read_before_init_raises():
    err = pytest.raises(CnosError, lambda: cnos.read("value.server.port"))
    assert "not initialized" in str(err.value).lower() or "not ready" in str(err.value).lower()


def test_set_default_runtime_makes_read_work():
    cnos.set_default_runtime(_make_runtime())
    val, found = cnos.value("server.port")
    assert found
    assert int(val) == 3000


def test_default_runtime_returns_set_instance():
    rt = _make_runtime()
    cnos.set_default_runtime(rt)
    assert cnos.default_runtime() is rt


def test_reset_default_runtime_clears_instance():
    cnos.set_default_runtime(_make_runtime())
    cnos.reset_default_runtime()
    with pytest.raises(CnosError):
        cnos.read("value.server.port")


def test_ready_is_idempotent():
    cnos.set_default_runtime(_make_runtime())
    first = cnos.default_runtime()
    # ready() on an already-initialized singleton keeps the same instance
    try:
        cnos.ready()
    except CnosError:
        pass  # no projection on disk — that's fine
    assert cnos.default_runtime() is first


# ---------------------------------------------------------------------------
# Tests: read / require / read_or
# ---------------------------------------------------------------------------

def test_read_returns_found_true_for_existing_key():
    cnos.set_default_runtime(_make_runtime())
    val, found = cnos.read("value.app.name")
    assert found
    assert val == "cnos-python"


def test_read_returns_found_false_for_missing_key():
    cnos.set_default_runtime(_make_runtime())
    _, found = cnos.read("value.does.not.exist")
    assert not found


def test_require_returns_value():
    cnos.set_default_runtime(_make_runtime())
    assert cnos.require("value.app.name") == "cnos-python"


def test_require_raises_for_missing_key():
    cnos.set_default_runtime(_make_runtime())
    with pytest.raises(CnosError):
        cnos.require("value.does.not.exist")


def test_read_or_returns_fallback_for_missing_key():
    cnos.set_default_runtime(_make_runtime())
    result = cnos.read_or("value.missing", "fallback")
    assert result == "fallback"


# ---------------------------------------------------------------------------
# Tests: value / secret / meta
# ---------------------------------------------------------------------------

def test_value_shortcut():
    cnos.set_default_runtime(_make_runtime())
    val, found = cnos.value("server.port")
    assert found
    assert int(val) == 3000


def test_secret_returns_not_found_when_no_secret_refs():
    cnos.set_default_runtime(_make_runtime())
    _, found = cnos.secret("does.not.exist")
    assert not found


def test_meta_returns_workspace():
    cnos.set_default_runtime(_make_runtime())
    val, found = cnos.meta("workspace")
    assert found
    assert val == "base"


# ---------------------------------------------------------------------------
# Tests: to_object / to_public_env / format
# ---------------------------------------------------------------------------

def test_to_object_returns_dict():
    cnos.set_default_runtime(_make_runtime())
    obj = cnos.to_object()
    assert isinstance(obj, dict)
    assert len(obj) > 0


def test_to_public_env_includes_promoted_keys():
    cnos.set_default_runtime(_make_runtime())
    env = cnos.to_public_env(ToPublicEnvOptions(framework="vite"))
    assert env.get("VITE_APP_NAME") == "cnos-python"


def test_format_substitutes_config_keys():
    cnos.set_default_runtime(_make_runtime())
    msg = cnos.format("App: ${value.app.name}")
    assert msg == "App: cnos-python"


def test_format_leaves_unknown_keys_unchanged():
    cnos.set_default_runtime(_make_runtime())
    msg = cnos.format("${value.does.not.exist}")
    assert msg == "${value.does.not.exist}"


# ---------------------------------------------------------------------------
# Tests: refresh_secrets / refresh_secret
# ---------------------------------------------------------------------------

def test_refresh_secrets_completes_without_error():
    cnos.set_default_runtime(_make_runtime())
    # No secrets in projection — should be a no-op
    cnos.refresh_secrets()


def test_refresh_secret_on_missing_path_is_noop():
    cnos.set_default_runtime(_make_runtime())
    # Non-existent secret path — should not raise
    cnos.refresh_secret("does.not.exist")


# ---------------------------------------------------------------------------
# Composition model tests
# ---------------------------------------------------------------------------
#
# Simulates: root → libA → libB → libC → libD, libE → libF
# Libraries call the singleton directly. Only the root initializes.

def _lib_f_read_meta() -> Any:
    """Leaf library — reads from singleton."""
    val, _ = cnos.meta("workspace")
    return val


def _lib_e_read_meta() -> Any:
    return _lib_f_read_meta()


def _lib_d_read_port() -> Any:
    """Leaf library — reads from singleton."""
    val, _ = cnos.value("server.port")
    return val


def _lib_c_read_port() -> Any:
    return _lib_d_read_port()


def _lib_b_read() -> tuple:
    return _lib_c_read_port(), _lib_e_read_meta()


def _lib_a_read() -> tuple:
    return _lib_b_read()


def test_composition_libraries_succeed_after_root_initializes():
    # Root initializes once
    cnos.set_default_runtime(_make_runtime())

    port, workspace = _lib_a_read()
    assert int(port) == 3000
    assert workspace == "base"


def test_composition_libraries_fail_before_root_initializes():
    # Root has NOT initialized — all library reads should fail
    with pytest.raises(CnosError):
        _lib_a_read()


def test_composition_multiple_libraries_share_same_runtime():
    rt = _make_runtime()
    cnos.set_default_runtime(rt)

    # All libraries use the same singleton
    assert cnos.default_runtime() is rt
    _ = _lib_a_read()
    assert cnos.default_runtime() is rt  # unchanged after reads


def test_composition_root_can_inject_test_runtime():
    """Root can inject a custom/test runtime; all libraries see it."""
    custom = load_projection(json.dumps({
        "version": 1,
        "workspace": "test",
        "profile": "local",
        "resolvedAt": "2024-01-01T00:00:00Z",
        "configHash": "test123",
        "values": {"server.port": 9999, "app.name": "test-app"},
        "derived": {},
        "secretRefs": {},
        "publicKeys": [],
        "runtimeNamespaces": [],
        "meta": {"workspace": "test", "profile": "local", "cnos_version": "1.14.0"},
    }).encode())

    cnos.set_default_runtime(custom)
    port, _ = cnos.value("server.port")
    assert int(port) == 9999
