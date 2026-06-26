"""InspectResult and nested types — mirrors Go's inspect.go."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from cnos.types import ConfigOrigin


@dataclass
class InspectWorkspace:
    id: str = ""
    source: str = ""
    chain: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {"id": self.id, "source": self.source, "chain": self.chain}


@dataclass
class InspectWinner:
    source_id: str = ""
    plugin_id: str = ""
    workspace_id: str = ""
    origin: Optional[ConfigOrigin] = None

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "sourceId": self.source_id,
            "pluginId": self.plugin_id,
            "workspaceId": self.workspace_id,
        }
        if self.origin:
            result["origin"] = self.origin.to_dict()
        return result


@dataclass
class InspectOverride:
    source_id: str = ""
    plugin_id: str = ""
    workspace_id: str = ""
    value: Any = None
    origin: Optional[ConfigOrigin] = None

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "sourceId": self.source_id,
            "pluginId": self.plugin_id,
            "workspaceId": self.workspace_id,
            "value": self.value,
        }
        if self.origin:
            result["origin"] = self.origin.to_dict()
        return result


@dataclass
class InspectDependency:
    key: str = ""
    value: Any = None
    runtime_namespace: str = ""

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {"key": self.key, "value": self.value}
        if self.runtime_namespace:
            result["runtimeNamespace"] = self.runtime_namespace
        return result


@dataclass
class InspectDerived:
    type: str = ""
    expression: str = ""
    dependencies: List[InspectDependency] = field(default_factory=list)
    runtime_dependent: bool = False
    runtime_namespaces: List[str] = field(default_factory=list)
    promotion_warning: str = ""

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "type": self.type,
            "expression": self.expression,
            "dependencies": [d.to_dict() for d in self.dependencies],
            "runtimeDependent": self.runtime_dependent,
            "runtimeNamespaces": self.runtime_namespaces,
        }
        if self.promotion_warning:
            result["promotionWarning"] = self.promotion_warning
        return result


@dataclass
class InspectWorkspaceState:
    id: str = ""
    source: str = ""
    chain: List[str] = field(default_factory=list)


@dataclass
class InspectResult:
    key: str = ""
    value: Any = None
    namespace: str = ""
    profile: str = ""
    profile_source: str = ""
    workspace: InspectWorkspace = field(default_factory=InspectWorkspace)
    winner: InspectWinner = field(default_factory=InspectWinner)
    overridden: List[InspectOverride] = field(default_factory=list)
    derived: Optional[InspectDerived] = None

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "key": self.key,
            "value": self.value,
            "namespace": self.namespace,
            "profile": self.profile,
            "profileSource": self.profile_source,
            "workspace": self.workspace.to_dict(),
            "winner": self.winner.to_dict(),
            "overridden": [o.to_dict() for o in self.overridden],
        }
        if self.derived is not None:
            result["derived"] = self.derived.to_dict()
        return result


def new_implicit_workspace_state(workspace: str) -> InspectWorkspaceState:
    ws = workspace.strip()
    if not ws:
        return InspectWorkspaceState(source="implicit")
    return InspectWorkspaceState(id=ws, source="implicit", chain=[ws])
