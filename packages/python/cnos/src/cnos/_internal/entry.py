"""Internal runtime entry and provenance types."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List, Optional

from cnos.types import ConfigOrigin, SecretReference


@dataclass
class RuntimeProvenance:
    source_id: str = ""
    plugin_id: str = ""
    workspace_id: str = ""
    value: Any = None
    origin: Optional[ConfigOrigin] = None


@dataclass
class RuntimeEntry:
    key: str = ""
    namespace: str = ""
    value: Any = None
    alias_to: str = ""
    promoted_from: str = ""
    formula: Optional[Any] = None  # ParsedFormula — avoid circular import
    formula_cached: bool = False
    formula_cache: Any = None
    secret_ref: Optional[SecretReference] = None
    winner: RuntimeProvenance = field(default_factory=RuntimeProvenance)
    overridden: List[RuntimeProvenance] = field(default_factory=list)
