"""RuntimeGraph wire type and parse_runtime_graph() — mirrors Go's graph.go."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from cnos.errors import CnosError
from cnos.projection import OverrideSpec
from cnos.types import ConfigOrigin

GRAPH_ENV_VAR = "__CNOS_GRAPH__"


@dataclass
class GraphConfigEntry:
    key: str = ""
    value: Any = None
    namespace: str = ""
    source_id: str = ""
    plugin_id: str = ""
    workspace_id: str = ""
    profile: str = ""
    origin: Optional[ConfigOrigin] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GraphConfigEntry":
        return cls(
            key=d.get("key", ""),
            value=d.get("value"),
            namespace=d.get("namespace", ""),
            source_id=d.get("sourceId", ""),
            plugin_id=d.get("pluginId", ""),
            workspace_id=d.get("workspaceId", ""),
            profile=d.get("profile", ""),
            origin=ConfigOrigin.from_dict(d.get("origin")),
            metadata=dict(d.get("metadata") or {}),
        )


@dataclass
class GraphResolvedEntry:
    key: str = ""
    value: Any = None
    namespace: str = ""
    winner: GraphConfigEntry = field(default_factory=GraphConfigEntry)
    overridden: List[GraphConfigEntry] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GraphResolvedEntry":
        return cls(
            key=d.get("key", ""),
            value=d.get("value"),
            namespace=d.get("namespace", ""),
            winner=GraphConfigEntry.from_dict(d.get("winner") or {}),
            overridden=[GraphConfigEntry.from_dict(o) for o in (d.get("overridden") or [])],
        )


@dataclass
class GraphWorkspaceRoot:
    scope: str = ""
    workspace_id: str = ""
    path: str = ""

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GraphWorkspaceRoot":
        return cls(
            scope=d.get("scope", ""),
            workspace_id=d.get("workspaceId", ""),
            path=d.get("path", ""),
        )


@dataclass
class GraphWorkspace:
    workspace_id: str = ""
    workspace_source: str = ""
    global_root: str = ""
    global_root_source: str = ""
    workspace_chain: List[str] = field(default_factory=list)
    workspace_roots: List[GraphWorkspaceRoot] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GraphWorkspace":
        return cls(
            workspace_id=d.get("workspaceId", ""),
            workspace_source=d.get("workspaceSource", ""),
            global_root=d.get("globalRoot", "") or "",
            global_root_source=d.get("globalRootSource", "") or "",
            workspace_chain=list(d.get("workspaceChain") or []),
            workspace_roots=[GraphWorkspaceRoot.from_dict(r) for r in (d.get("workspaceRoots") or [])],
        )


@dataclass
class RuntimeGraph:
    entries: List[GraphResolvedEntry] = field(default_factory=list)
    profile: str = ""
    resolved_at: str = ""
    profile_source: str = ""
    workspace: GraphWorkspace = field(default_factory=GraphWorkspace)
    overrides: Dict[str, OverrideSpec] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RuntimeGraph":
        return cls(
            entries=[GraphResolvedEntry.from_dict(e) for e in (d.get("entries") or [])],
            profile=d.get("profile", ""),
            resolved_at=d.get("resolvedAt", ""),
            profile_source=d.get("profileSource", ""),
            workspace=GraphWorkspace.from_dict(d.get("workspace") or {}),
            overrides={k: OverrideSpec.from_dict(v) for k, v in (d.get("overrides") or {}).items()},
        )


def parse_runtime_graph(data: bytes) -> RuntimeGraph:
    """Parse and validate a runtime graph JSON payload."""
    try:
        raw = json.loads(data)
    except (json.JSONDecodeError, ValueError) as exc:
        raise CnosError(f"cnos: parse runtime graph: {exc}") from exc

    if not isinstance(raw, dict):
        raise CnosError("cnos: invalid runtime graph payload")

    graph = RuntimeGraph.from_dict(raw)

    if (
        not graph.profile
        or not graph.resolved_at
        or not graph.profile_source
        or not graph.workspace.workspace_id
        or not graph.workspace.workspace_source
        or graph.workspace.workspace_chain is None
        or graph.entries is None
    ):
        raise CnosError("cnos: invalid runtime graph payload")

    for entry in graph.entries:
        w = entry.winner
        if (
            not entry.key
            or not entry.namespace
            or not w.key
            or not w.namespace
            or not w.source_id
            or not w.plugin_id
            or not w.workspace_id
        ):
            raise CnosError("cnos: invalid runtime graph payload")

    return graph
