"""Projection file discovery — mirrors Go's discover.go."""
from __future__ import annotations

import os
from typing import Optional

PROJECTION_FILE_NAME = ".cnos-server.json"


def find_projection_path(working_dir: str = "") -> Optional[str]:
    """Find .cnos-server.json by checking cwd then walking up 3 levels near .cnosrc.yml."""
    cwd = _resolve_working_dir(working_dir)

    # Direct candidate at cwd
    direct = os.path.join(cwd, PROJECTION_FILE_NAME)
    if _file_exists(direct):
        return direct

    # Walk up looking for .cnosrc.yml alongside .cnos-server.json
    current = cwd
    for _ in range(4):  # depth 0..3
        rc_candidate = os.path.join(current, ".cnosrc.yml")
        if _file_exists(rc_candidate):
            proj_candidate = os.path.join(current, PROJECTION_FILE_NAME)
            if _file_exists(proj_candidate):
                return proj_candidate
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent

    return None


def _resolve_working_dir(working_dir: str) -> str:
    if working_dir:
        return os.path.abspath(working_dir)
    return os.getcwd()


def _file_exists(path: str) -> bool:
    return os.path.isfile(path)


def resolve_path_from_working_dir(working_dir: str, target: str) -> str:
    if os.path.isabs(target):
        return target
    base = _resolve_working_dir(working_dir)
    return os.path.join(base, target)
