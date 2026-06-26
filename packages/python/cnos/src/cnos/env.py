"""Environment abstraction — mirrors Go's environment struct."""
from __future__ import annotations

import os
from typing import Dict, Optional, Tuple


class Environment:
    """Wraps real or injected environment variables."""

    def __init__(self, override: Optional[Dict[str, str]] = None) -> None:
        if override is None:
            self._override: Optional[Dict[str, str]] = None
            self._use_os = True
        else:
            self._override = dict(override)
            self._use_os = False

    def get(self, key: str) -> Tuple[Optional[str], bool]:
        """Return (value, found)."""
        if self._use_os:
            value = os.environ.get(key)
            return value, value is not None
        if self._override is not None:
            if key in self._override:
                return self._override[key], True
        return None, False

    def process_env(self) -> Dict[str, str]:
        """Return a merged dict of os.environ + any override."""
        values: Dict[str, str] = dict(os.environ)
        if not self._use_os and self._override:
            values.update(self._override)
        return values

    @property
    def use_os(self) -> bool:
        return self._use_os
