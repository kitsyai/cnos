"""CNOS public type definitions."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


@dataclass
class DerivedFormula:
    """Wire type for a derived formula baked into a projection."""
    expr: str
    deps: List[str] = field(default_factory=list)
    runtime_refs: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DerivedFormula":
        return cls(
            expr=d.get("expr", ""),
            deps=list(d.get("deps") or []),
            runtime_refs=list(d.get("runtimeRefs") or []),
        )

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {"expr": self.expr, "deps": self.deps}
        if self.runtime_refs:
            result["runtimeRefs"] = self.runtime_refs
        return result


@dataclass
class SecretReference:
    """Wire type for a secret reference in a projection."""
    ref: str
    provider: str = ""
    vault: str = ""
    env_var: str = ""

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SecretReference":
        return cls(
            ref=d.get("ref", ""),
            provider=d.get("provider", "") or "",
            vault=d.get("vault", "") or "",
            env_var=d.get("envVar", "") or "",
        )

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {"ref": self.ref}
        if self.provider:
            result["provider"] = self.provider
        if self.vault:
            result["vault"] = self.vault
        if self.env_var:
            result["envVar"] = self.env_var
        return result


@dataclass
class VaultAuthSource:
    """Describes where auth material (passphrase/token) is resolved from."""
    from_: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Optional[Dict[str, Any]]) -> Optional["VaultAuthSource"]:
        if d is None:
            return None
        return cls(from_=list(d.get("from") or []))

    def to_dict(self) -> Dict[str, Any]:
        return {"from": self.from_}


@dataclass
class VaultAuthConfig:
    """Resolved in-memory auth material for a vault."""
    method: str = ""
    passphrase: str = ""
    token: str = ""
    config: Dict[str, Any] = field(default_factory=dict)


@dataclass
class VaultAuthDefinition:
    """Non-secret auth metadata projected for a vault."""
    method: str = ""
    passphrase: Optional[VaultAuthSource] = None
    token: Optional[VaultAuthSource] = None
    config: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "VaultAuthDefinition":
        passphrase_raw = d.get("passphrase")
        token_raw = d.get("token")
        return cls(
            method=d.get("method", "") or "",
            passphrase=VaultAuthSource.from_dict(passphrase_raw) if passphrase_raw else None,
            token=VaultAuthSource.from_dict(token_raw) if token_raw else None,
            config=dict(d.get("config") or {}),
        )

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        if self.method:
            result["method"] = self.method
        if self.passphrase is not None:
            result["passphrase"] = self.passphrase.to_dict()
        if self.token is not None:
            result["token"] = self.token.to_dict()
        if self.config:
            result["config"] = self.config
        return result


@dataclass
class VaultDefinition:
    """Runtime-safe vault definition passed to providers."""
    provider: str = ""
    auth: VaultAuthDefinition = field(default_factory=VaultAuthDefinition)
    mapping: Dict[str, str] = field(default_factory=dict)
    fallback: List["VaultDefinition"] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "VaultDefinition":
        fallback_raw = d.get("fallback") or []
        auth_raw = d.get("auth") or {}
        return cls(
            provider=d.get("provider", "") or "",
            auth=VaultAuthDefinition.from_dict(auth_raw),
            mapping=dict(d.get("mapping") or {}),
            fallback=[cls.from_dict(f) for f in fallback_raw],
        )

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {"provider": self.provider}
        auth_dict = self.auth.to_dict()
        if auth_dict:
            result["auth"] = auth_dict
        if self.mapping:
            result["mapping"] = self.mapping
        if self.fallback:
            result["fallback"] = [f.to_dict() for f in self.fallback]
        return result


@dataclass
class ConfigOrigin:
    """Tracks where a config value originated."""
    file: str = ""
    line: int = 0
    env_var: str = ""
    cli_arg: str = ""

    @classmethod
    def from_dict(cls, d: Optional[Dict[str, Any]]) -> Optional["ConfigOrigin"]:
        if d is None:
            return None
        return cls(
            file=d.get("file", "") or "",
            line=d.get("line", 0) or 0,
            env_var=d.get("envVar", "") or "",
            cli_arg=d.get("cliArg", "") or "",
        )

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        if self.file:
            result["file"] = self.file
        if self.line:
            result["line"] = self.line
        if self.env_var:
            result["envVar"] = self.env_var
        if self.cli_arg:
            result["cliArg"] = self.cli_arg
        return result


@dataclass
class ToEnvOptions:
    include_secrets: bool = False


@dataclass
class ToPublicEnvOptions:
    framework: str = ""
    prefix: str = ""


# --- SecretVaultProvider Protocol ---

class SecretVaultProvider:
    """Protocol for vault provider implementations."""

    def authenticate(self, auth: VaultAuthConfig) -> None:
        raise NotImplementedError

    def batch_get(self, refs: List[str]) -> Dict[str, Any]:
        raise NotImplementedError

    def get(self, ref: str) -> Optional[Any]:
        raise NotImplementedError


@dataclass
class SecretVaultProviderFactory:
    """Registers a provider implementation by provider name."""
    provider: str
    create: Callable[["str", VaultDefinition], SecretVaultProvider]
