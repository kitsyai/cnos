"""ServerProjection wire type and parse_projection() — mirrors Go's projection.go."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from cnos.errors import CnosError
from cnos.types import DerivedFormula, SecretReference, VaultDefinition

PROJECTION_ENV_VAR = "__CNOS_PROJECTION__"
SECRET_PAYLOAD_ENV_VAR = "__CNOS_SECRET_PAYLOAD__"
SESSION_KEY_ENV_VAR = "__CNOS_SESSION_KEY__"


@dataclass
class ProjectionMeta:
    workspace: str = ""
    profile: str = ""
    cnos_version: str = ""
    namespaces: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ProjectionMeta":
        return cls(
            workspace=d.get("workspace", "") or "",
            profile=d.get("profile", "") or "",
            cnos_version=d.get("cnos_version", "") or "",
            namespaces=list(d.get("namespaces") or []),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "workspace": self.workspace,
            "profile": self.profile,
            "cnos_version": self.cnos_version,
            "namespaces": self.namespaces,
        }


@dataclass
class ServerProjection:
    version: int = 0
    workspace: str = ""
    profile: str = ""
    resolved_at: str = ""
    config_hash: str = ""
    values: Dict[str, Any] = field(default_factory=dict)
    derived: Dict[str, DerivedFormula] = field(default_factory=dict)
    secret_refs: Dict[str, SecretReference] = field(default_factory=dict)
    vaults: Dict[str, VaultDefinition] = field(default_factory=dict)
    public_keys: List[str] = field(default_factory=list)
    runtime_namespaces: List[str] = field(default_factory=list)
    meta: ProjectionMeta = field(default_factory=ProjectionMeta)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "workspace": self.workspace,
            "profile": self.profile,
            "resolvedAt": self.resolved_at,
            "configHash": self.config_hash,
            "values": self.values,
            "derived": {k: v.to_dict() for k, v in self.derived.items()},
            "secretRefs": {k: v.to_dict() for k, v in self.secret_refs.items()},
            "vaults": {k: v.to_dict() for k, v in self.vaults.items()},
            "publicKeys": self.public_keys,
            "runtimeNamespaces": self.runtime_namespaces,
            "meta": self.meta.to_dict(),
        }


def parse_projection(data: bytes) -> ServerProjection:
    """Parse and validate a server projection JSON payload."""
    try:
        raw = json.loads(data)
    except (json.JSONDecodeError, ValueError) as exc:
        raise CnosError(f"cnos: parse server projection: {exc}") from exc

    if not isinstance(raw, dict):
        raise CnosError("cnos: invalid server projection payload")

    version = raw.get("version")
    workspace = raw.get("workspace", "")
    profile = raw.get("profile", "")
    resolved_at = raw.get("resolvedAt", "")
    config_hash = raw.get("configHash", "")
    values = raw.get("values")
    secret_refs_raw = raw.get("secretRefs")
    public_keys = raw.get("publicKeys")
    meta_raw = raw.get("meta") or {}
    meta_workspace = meta_raw.get("workspace", "")
    meta_profile = meta_raw.get("profile", "")
    meta_cnos_version = meta_raw.get("cnos_version", "")

    if (
        version != 1
        or not workspace
        or not profile
        or not resolved_at
        or not config_hash
        or values is None
        or secret_refs_raw is None
        or public_keys is None
        or not meta_workspace
        or not meta_profile
        or not meta_cnos_version
    ):
        raise CnosError("cnos: invalid server projection payload")

    # Parse derived
    derived: Dict[str, DerivedFormula] = {}
    for k, v in (raw.get("derived") or {}).items():
        derived[k] = DerivedFormula.from_dict(v)

    # Parse vaults
    vaults: Dict[str, VaultDefinition] = {}
    for k, v in (raw.get("vaults") or {}).items():
        vaults[k] = VaultDefinition.from_dict(v)

    # Parse secret refs + normalize
    secret_refs: Dict[str, SecretReference] = {}
    for k, v in secret_refs_raw.items():
        ref = SecretReference.from_dict(v)
        if not ref.vault:
            ref.vault = "default"
        if not ref.provider:
            if ref.vault in vaults and vaults[ref.vault].provider:
                ref.provider = vaults[ref.vault].provider
            else:
                ref.provider = "local"
        secret_refs[k] = ref

    meta = ProjectionMeta.from_dict(meta_raw)
    if not meta.namespaces:
        meta.namespaces = []

    return ServerProjection(
        version=version,
        workspace=workspace,
        profile=profile,
        resolved_at=resolved_at,
        config_hash=config_hash,
        values=dict(values),
        derived=derived,
        secret_refs=secret_refs,
        vaults=vaults,
        public_keys=list(public_keys),
        runtime_namespaces=list(raw.get("runtimeNamespaces") or []),
        meta=meta,
    )
