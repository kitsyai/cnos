"""CNOS error types."""
from __future__ import annotations


class CnosError(Exception):
    """Base error type for all CNOS errors."""


PROJECTION_NOT_FOUND_MSG = (
    "cnos: no server projection found. "
    "Set __CNOS_PROJECTION__ or __CNOS_GRAPH__, place a .cnos-server.json nearby, "
    "or pass projection_data / projection_path."
)

MISSING_KEY_MSG = "cnos: missing config key"


def projection_not_found() -> CnosError:
    return CnosError(PROJECTION_NOT_FOUND_MSG)


def missing_key(key: str) -> CnosError:
    return CnosError(f"{MISSING_KEY_MSG}: {key}")


def runtime_not_ready() -> CnosError:
    return CnosError(
        "cnos: runtime not initialized. Call cnos.ready() or load a runtime and set it as default"
    )
