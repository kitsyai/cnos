"""load(), load_projection(), load_projection_file() + singleton state.
Mirrors Go's singleton.go and the Load/LoadProjection/LoadProjectionFile functions
in runtime.go.
"""
from __future__ import annotations

import os
import sys
import threading
from typing import List, Optional

from cnos.discover import find_projection_path, resolve_path_from_working_dir
from cnos.env import Environment
from cnos.errors import CnosError, projection_not_found, runtime_not_ready
from cnos.graph import GRAPH_ENV_VAR
from cnos.projection import PROJECTION_ENV_VAR
from cnos.runtime import (
    CnosRuntime,
    _parse_cli_args,
    _secret_vault_factory_map,
    new_dynamic_runtime,
    new_runtime,
    new_runtime_from_graph,
)
from cnos.secrets import resolve_secret_home
from cnos.types import SecretVaultProviderFactory


class CnosOptions:
    """Options for loading the CNOS runtime. Mirrors Go's Options struct."""

    def __init__(
        self,
        projection_path: str = "",
        projection_data: Optional[bytes] = None,
        root: str = "",
        workspace: str = "",
        profile: str = "",
        global_root: str = "",
        working_dir: str = "",
        environment: Optional[dict] = None,
        secret_home: str = "",
        secret_vault_providers: Optional[List[SecretVaultProviderFactory]] = None,
    ) -> None:
        self.projection_path = projection_path
        self.projection_data = projection_data
        self.root = root
        self.workspace = workspace
        self.profile = profile
        self.global_root = global_root
        self.working_dir = working_dir
        self.environment = environment
        self.secret_home = secret_home
        self.secret_vault_providers: List[SecretVaultProviderFactory] = secret_vault_providers or []


# ---------------------------------------------------------------------------
# Singleton state
# ---------------------------------------------------------------------------

_default_runtime: Optional[CnosRuntime] = None
_lock = threading.Lock()


def set_default_runtime(runtime: CnosRuntime) -> None:
    global _default_runtime
    with _lock:
        _default_runtime = runtime


def default_runtime() -> CnosRuntime:
    with _lock:
        rt = _default_runtime
    if rt is None:
        raise runtime_not_ready()
    return rt


def _reset_default_runtime() -> None:
    """For tests only."""
    global _default_runtime
    with _lock:
        _default_runtime = None


# ---------------------------------------------------------------------------
# Load functions
# ---------------------------------------------------------------------------

def load(options: Optional[CnosOptions] = None) -> CnosRuntime:
    """Load a CNOS runtime. Checks sources in priority order."""
    opts = options or CnosOptions()
    env = Environment(opts.environment)
    secret_home = resolve_secret_home(env, opts.secret_home)
    factories = opts.secret_vault_providers or []

    # 1. Explicit projection data
    if opts.projection_data:
        return new_runtime(opts.projection_data, env, secret_home, factories)

    # 2. Explicit projection path
    if opts.projection_path:
        resolved = resolve_path_from_working_dir(opts.working_dir, opts.projection_path)
        try:
            with open(resolved, "rb") as f:
                data = f.read()
        except OSError as exc:
            raise CnosError(f"cnos: read projection file {resolved}: {exc}") from exc
        return new_runtime(data, env, secret_home, factories)

    # 3. __CNOS_GRAPH__ env var
    graph_serialized, graph_found = env.get(GRAPH_ENV_VAR)
    if graph_found and graph_serialized:
        return new_runtime_from_graph(graph_serialized.encode(), env, secret_home, factories)

    # 4. __CNOS_PROJECTION__ env var
    proj_serialized, proj_found = env.get(PROJECTION_ENV_VAR)
    if proj_found and proj_serialized:
        return new_runtime(proj_serialized.encode(), env, secret_home, factories)

    # 5. .cnos-server.json file discovery
    proj_path = find_projection_path(opts.working_dir)
    if proj_path:
        try:
            with open(proj_path, "rb") as f:
                data = f.read()
        except OSError as exc:
            raise CnosError(f"cnos: read projection file {proj_path}: {exc}") from exc
        return new_runtime(data, env, secret_home, factories)

    # 5.5. Explicit runtime projection path: --cnos-projection or CNOS_SERVER_PROJECTION_PATH
    parsed_args = _parse_cli_args(sys.argv[1:])
    runtime_proj: Optional[str] = parsed_args.get("--cnos-projection")
    if not runtime_proj:
        _ep, _found = env.get("CNOS_SERVER_PROJECTION_PATH")
        if _found and _ep:
            runtime_proj = _ep
    if runtime_proj:
        resolved = resolve_path_from_working_dir(opts.working_dir, runtime_proj)
        try:
            with open(resolved, "rb") as f:
                data = f.read()
        except OSError as exc:
            raise CnosError(f"cnos: read projection file {resolved}: {exc}") from exc
        return new_runtime(data, env, secret_home, factories)

    # 6. Dynamic mode: CNOS_DYNAMIC=1 or --cnos-dynamic — suppress projection-not-found.
    # env.* and args.* reads work; value.* returns None unless supplied via --cnos-patch.
    if parsed_args.get("--cnos-dynamic") == "true":
        return new_dynamic_runtime(env, secret_home, factories)
    _dv, _dfound = env.get("CNOS_DYNAMIC")
    if _dfound and _dv and _dv.lower() in ("1", "true", "yes"):
        return new_dynamic_runtime(env, secret_home, factories)

    raise projection_not_found()


def load_projection(data: bytes, options: Optional[CnosOptions] = None) -> CnosRuntime:
    opts = options or CnosOptions()
    opts.projection_data = data
    return load(opts)


def load_projection_file(path: str, options: Optional[CnosOptions] = None) -> CnosRuntime:
    opts = options or CnosOptions()
    opts.projection_path = path
    return load(opts)


# ---------------------------------------------------------------------------
# Ready / singleton bootstrap
# ---------------------------------------------------------------------------

def ready(options: Optional[CnosOptions] = None) -> None:
    """Initialize the default runtime if not already set, then warm secrets."""
    opts = options or CnosOptions()
    with _lock:
        rt = _default_runtime
    if rt is not None:
        if opts.secret_vault_providers:
            rt.register_secret_vault_providers(*opts.secret_vault_providers)
        rt._warm_secrets()
        return

    loaded = load(opts)
    loaded._warm_secrets()
    set_default_runtime(loaded)


def bootstrap_default_runtime() -> None:
    """Eagerly bootstrap the default runtime from environment / fs, ignoring errors.
    Mirrors Go's init() -> bootstrapDefaultRuntime().
    """
    global _default_runtime
    with _lock:
        if _default_runtime is not None:
            return

    env = Environment()
    try:
        secret_home = resolve_secret_home(env, "")
    except Exception:
        return

    try:
        graph_serialized, graph_found = env.get(GRAPH_ENV_VAR)
        if graph_found and graph_serialized:
            rt = new_runtime_from_graph(graph_serialized.encode(), env, secret_home, [])
            with _lock:
                _default_runtime = rt
            return

        proj_serialized, proj_found = env.get(PROJECTION_ENV_VAR)
        if proj_found and proj_serialized:
            rt = new_runtime(proj_serialized.encode(), env, secret_home, [])
            with _lock:
                _default_runtime = rt
            return

        proj_path = find_projection_path("")
        if proj_path:
            with open(proj_path, "rb") as f:
                data = f.read()
            rt = new_runtime(data, env, secret_home, [])
            with _lock:
                _default_runtime = rt
    except Exception:
        pass
