"""CnosRuntime — core runtime class mirroring Go's runtime.go."""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from cnos._internal.entry import RuntimeEntry, RuntimeProvenance
from cnos.derive import (
    ParsedFormula,
    _unique_sorted,
    evaluate_derived_formula,
    is_derived_value,
    parse_derived_formula,
    parse_raw_derived_value,
    formula_type,
)
from cnos.env import Environment
from cnos.errors import CnosError, missing_key
from cnos.graph import GraphResolvedEntry, RuntimeGraph, parse_runtime_graph
from cnos.inspect import (
    InspectDependency,
    InspectDerived,
    InspectOverride,
    InspectResult,
    InspectWinner,
    InspectWorkspace,
    InspectWorkspaceState,
    new_implicit_workspace_state,
)
from cnos.jscompat import js_log_stringify_value, js_stringify_value, node_arch, node_platform
from cnos.projection import ProjectionMeta, ServerProjection, parse_projection
from cnos.secrets import (
    decrypt_secret_payload_from_env,
    read_local_vault_secrets,
    resolve_secret_home,
    resolve_vault_auth,
    _default_vault_method,
)
from cnos.types import (
    ConfigOrigin,
    DerivedFormula,
    SecretReference,
    SecretVaultProviderFactory,
    ToEnvOptions,
    ToPublicEnvOptions,
    VaultAuthDefinition,
    VaultAuthSource,
    VaultDefinition,
)

RuntimeProvider = Callable[[str], Any]


# ---------------------------------------------------------------------------
# Namespace definitions (bootstrapped)
# ---------------------------------------------------------------------------

_DEFAULT_NAMESPACE_DEFS: Dict[str, Dict[str, Any]] = {
    "value":   {"kind": "data",       "shareable": True,  "sensitive": False, "readonly": False},
    "secret":  {"kind": "data",       "shareable": False, "sensitive": True,  "readonly": False},
    "meta":    {"kind": "system",     "shareable": False, "sensitive": False, "readonly": True},
    "process": {"kind": "system",     "shareable": False, "sensitive": False, "readonly": True},
    "public":  {"kind": "projection", "shareable": True,  "sensitive": False, "readonly": True, "source": "promote"},
    "env":     {"kind": "projection", "shareable": True,  "sensitive": False, "readonly": True, "source": "envMapping"},
}

_DEFAULT_FRAMEWORKS: Dict[str, str] = {
    "next":    "NEXT_PUBLIC_",
    "vite":    "VITE_",
    "nuxt":    "NUXT_PUBLIC_",
    "webpack": "",
}


def _first_non_empty(*values: str) -> str:
    for v in values:
        if v and v.strip():
            return v.strip()
    return ""


def _unique_sorted_list(values: List[str]) -> List[str]:
    seen: Set[str] = set()
    result: List[str] = []
    for v in values:
        if v and v not in seen:
            seen.add(v)
            result.append(v)
    return sorted(result)


def filter_formula_deps(refs: List[str], runtime_namespaces: Set[str]) -> List[str]:
    deps: List[str] = []
    for ref in refs:
        namespace = _namespace_for_key(ref)
        if not namespace:
            continue
        if namespace in runtime_namespaces:
            continue
        deps.append(ref)
    return _unique_sorted_list(deps)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _namespace_for_key(key: str) -> str:
    if "." in key:
        return key.split(".", 1)[0]
    return ""


def _split_logical_key(key: str) -> Tuple[str, str, bool]:
    if "." in key:
        ns, rest = key.split(".", 1)
        return ns, rest, True
    return "", "", False


def _to_logical_key(namespace: str, value_path: str) -> str:
    # Idempotency guard: already-prefixed key passes through unchanged.
    if value_path.startswith(namespace + "."):
        return value_path
    parts = [chunk.strip() for chunk in value_path.split(".") if chunk.strip()]
    return namespace + "." + ".".join(parts)


def _clone_origin(origin: Optional[ConfigOrigin]) -> Optional[ConfigOrigin]:
    if origin is None:
        return None
    from dataclasses import replace
    return replace(origin)


def _clone_vault_def(definition: VaultDefinition) -> VaultDefinition:
    # shallow clone — sufficient for runtime use
    from dataclasses import replace, field
    return VaultDefinition(
        provider=definition.provider,
        auth=definition.auth,
        mapping=dict(definition.mapping),
        fallback=list(definition.fallback),
    )


# ---------------------------------------------------------------------------
# Bootstrapped manifest equivalents
# ---------------------------------------------------------------------------

def _bootstrapped_manifest_from_projection(projection: ServerProjection) -> Dict[str, Any]:
    namespaces = dict(_DEFAULT_NAMESPACE_DEFS)
    for namespace in projection.meta.namespaces:
        if namespace not in namespaces:
            namespaces[namespace] = {"kind": "data"}

    runtime_namespaces: Dict[str, Any] = {
        "process": {"description": "Live process runtime values.", "server_only": True, "built_in": True}
    }
    for namespace in projection.runtime_namespaces:
        if namespace == "process":
            continue
        runtime_namespaces[namespace] = {"server_only": True}

    frameworks = dict(_DEFAULT_FRAMEWORKS)

    return {
        "project_name":        "bootstrapped",
        "env_mapping":         {"convention": "", "explicit": {}},
        "frameworks":          frameworks,
        "namespaces":          namespaces,
        "runtime_namespaces":  runtime_namespaces,
        "vaults":              dict(projection.vaults),
    }


def _bootstrapped_manifest_from_graph(graph: RuntimeGraph) -> Dict[str, Any]:
    namespaces = dict(_DEFAULT_NAMESPACE_DEFS)

    runtime_namespaces: Dict[str, Any] = {
        "process": {"description": "Live process runtime values.", "server_only": True, "built_in": True}
    }
    for namespace in _discover_runtime_namespaces_from_graph(graph):
        if namespace == "process":
            continue
        runtime_namespaces[namespace] = {"server_only": True}

    frameworks = dict(_DEFAULT_FRAMEWORKS)

    return {
        "project_name":        "bootstrapped",
        "workspace_default":   graph.workspace.workspace_id,
        "profile_default":     graph.profile,
        "resolve_from":        ["default"],
        "env_mapping":         {"convention": "", "explicit": {}},
        "frameworks":          frameworks,
        "namespaces":          namespaces,
        "runtime_namespaces":  runtime_namespaces,
        "vaults":              {},
    }


def _discover_runtime_namespaces_from_graph(graph: RuntimeGraph) -> List[str]:
    config_namespaces: Set[str] = {"value", "secret", "meta", "public"}
    for entry in graph.entries:
        config_namespaces.add(entry.namespace)

    runtime_namespaces: Set[str] = set()
    for entry in graph.entries:
        if not is_derived_value(entry.value):
            continue
        try:
            parsed = parse_raw_derived_value(entry.value)
        except CnosError:
            continue
        for ref in parsed.refs:
            namespace = _namespace_for_key(ref)
            if not namespace:
                continue
            if namespace in config_namespaces:
                continue
            runtime_namespaces.add(namespace)
    return sorted(runtime_namespaces)


def _runtime_entry_from_graph(resolved: GraphResolvedEntry) -> RuntimeEntry:
    entry = RuntimeEntry(
        key=resolved.key,
        namespace=resolved.namespace,
        winner=RuntimeProvenance(
            source_id=resolved.winner.source_id,
            plugin_id=resolved.winner.plugin_id,
            workspace_id=resolved.winner.workspace_id,
            origin=_clone_origin(resolved.winner.origin),
        ),
    )

    promoted_from = (resolved.winner.metadata or {}).get("promotedFrom", "")
    if promoted_from:
        entry.promoted_from = promoted_from

    for override in resolved.overridden:
        entry.overridden.append(RuntimeProvenance(
            source_id=override.source_id,
            plugin_id=override.plugin_id,
            workspace_id=override.workspace_id,
            value=override.value,
            origin=_clone_origin(override.origin),
        ))

    def _is_secret_ref(v: Any) -> bool:
        from cnos.secrets import _is_secret_reference_value
        return _is_secret_reference_value(v)

    def _to_secret_ref(v: Any) -> SecretReference:
        from cnos.secrets import _to_secret_reference
        return _to_secret_reference(v)

    if resolved.namespace == "secret" and _is_secret_ref(resolved.value):
        ref = _to_secret_ref(resolved.value)
        if not ref.vault:
            ref.vault = "default"
        entry.secret_ref = ref
        return entry

    if is_derived_value(resolved.value):
        parsed = parse_raw_derived_value(resolved.value)
        entry.formula = parsed
        return entry

    entry.value = resolved.value
    return entry


# ---------------------------------------------------------------------------
# CnosRuntime
# ---------------------------------------------------------------------------

class CnosRuntime:
    """Python equivalent of Go's Runtime struct."""

    def __init__(
        self,
        projection: ServerProjection,
        manifest: Dict[str, Any],
        profile_source: str,
        workspace_state: InspectWorkspaceState,
        graph_bootstrapped: bool,
        env: Environment,
        secret_home: str,
        entries: Dict[str, RuntimeEntry],
        sources: Dict[str, str],
        runtime_namespaces: Set[str],
        runtime_providers: Dict[str, RuntimeProvider],
        encrypted_secrets: Optional[Dict[str, Any]],
        hydrated_secrets: Dict[str, Any],
        local_vault_cache: Dict[str, Dict[str, str]],
        logical_key_to_vault: Dict[str, str],
        vaults: Dict[str, VaultDefinition],
        secret_factories: Dict[str, SecretVaultProviderFactory],
    ) -> None:
        self._projection = projection
        self._manifest = manifest
        self._profile_source = profile_source
        self._workspace_state = workspace_state
        self._graph_bootstrapped = graph_bootstrapped
        self._env = env
        self._secret_home = secret_home
        self._entries = entries
        self._sources = sources
        self._runtime_namespaces = runtime_namespaces
        self._runtime_providers = runtime_providers
        self._encrypted_secrets = encrypted_secrets or {}
        self._hydrated_secrets = hydrated_secrets
        self._local_vault_cache = local_vault_cache
        self._logical_key_to_vault = logical_key_to_vault
        self._vaults = vaults
        self._secret_factories = secret_factories

    # -----------------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------------

    def projection(self) -> ServerProjection:
        return self._projection

    def read(self, key: str) -> Tuple[Any, bool]:
        """Returns (value, found). Raises CnosError on error."""
        return self._read_internal(key, set())

    def require(self, key: str) -> Any:
        value, ok = self.read(key)
        if not ok:
            raise missing_key(key)
        return value

    def read_or(self, key: str, fallback: Any) -> Any:
        value, ok = self.read(key)
        if not ok:
            return fallback
        return value

    def value(self, path: str) -> Tuple[Any, bool]:
        return self.read(_to_logical_key("value", path))

    def secret(self, path: str) -> Tuple[Any, bool]:
        return self.read(_to_logical_key("secret", path))

    def meta(self, path: str) -> Tuple[Any, bool]:
        return self.read(_to_logical_key("meta", path))

    def public(self, path: str) -> Tuple[Any, bool]:
        return self.read(_to_logical_key("public", path))

    def register_runtime_provider(self, namespace: str, provider: RuntimeProvider) -> None:
        if namespace == "process":
            raise CnosError(f'cnos: cannot override built-in runtime namespace "process"')
        if namespace not in self._runtime_namespaces:
            raise CnosError(
                f'cnos: cannot register runtime provider for undeclared namespace "{namespace}"'
            )
        self._runtime_providers[namespace] = provider

    def register_secret_vault_providers(
        self, *factories: SecretVaultProviderFactory
    ) -> None:
        for factory in factories:
            provider = (factory.provider or "").strip()
            if not provider or factory.create is None:
                continue
            self._secret_factories[provider] = factory

    def refresh_secrets(self) -> None:
        refreshed = self._with_secret_caches({}, {})
        refreshed._warm_secrets()
        self._hydrated_secrets = refreshed._hydrated_secrets
        self._local_vault_cache = refreshed._local_vault_cache

    def refresh_secret(self, path: str) -> None:
        key = _to_logical_key("secret", path)
        entry = self._entries.get(key)
        if entry is None or entry.secret_ref is None:
            return

        hydrated = dict(self._hydrated_secrets)
        hydrated.pop(key, None)
        local_cache = _clone_local_vault_cache(self._local_vault_cache)
        vault = self._logical_key_to_vault.get(key)
        if vault:
            local_cache.pop(vault, None)

        refreshed = self._with_secret_caches(hydrated, local_cache)
        refreshed._read_secret(key, entry.secret_ref)

        self._hydrated_secrets.pop(key, None)
        if key in refreshed._hydrated_secrets:
            self._hydrated_secrets[key] = refreshed._hydrated_secrets[key]
        if vault:
            if vault in refreshed._local_vault_cache:
                self._local_vault_cache[vault] = refreshed._local_vault_cache[vault]
            else:
                self._local_vault_cache.pop(vault, None)

    def inspect(self, key: str) -> InspectResult:
        entry = self._entries.get(key)
        if entry is None:
            raise missing_key(key)

        value, _ = self.read(key)

        result = InspectResult(
            key=key,
            value=value,
            namespace=entry.namespace,
            profile=self._profile_workspace("profile"),
            profile_source=_first_non_empty(self._profile_source, "manifest-default"),
            workspace=InspectWorkspace(
                id=_first_non_empty(self._workspace_state.id, self._profile_workspace("workspace")),
                source=_first_non_empty(self._workspace_state.source, "implicit"),
                chain=self._inspect_workspace_chain(),
            ),
            winner=InspectWinner(
                source_id=_first_non_empty(entry.winner.source_id, self._sources.get(key, "")),
                plugin_id=_first_non_empty(entry.winner.plugin_id, "cnos"),
                workspace_id=_first_non_empty(entry.winner.workspace_id, self._profile_workspace("workspace")),
                origin=_clone_origin(entry.winner.origin),
            ),
            overridden=[
                InspectOverride(
                    source_id=o.source_id,
                    plugin_id=_first_non_empty(o.plugin_id, o.source_id),
                    workspace_id=o.workspace_id,
                    value=o.value,
                    origin=_clone_origin(o.origin),
                )
                for o in entry.overridden
            ],
        )

        if entry.formula is not None:
            result.derived = self._inspect_derived(key, entry)

        return result

    # -----------------------------------------------------------------------
    # Internal read
    # -----------------------------------------------------------------------

    def _read_internal(self, key: str, stack: Set[str]) -> Tuple[Any, bool]:
        entry = self._entries.get(key)
        if entry is None:
            ns, rest, found = _split_logical_key(key)
            if found:
                provider = self._runtime_providers.get(ns)
                if provider is not None:
                    return provider(rest), True
            return None, False

        if entry.alias_to:
            return self._read_internal(entry.alias_to, stack)

        if entry.secret_ref is not None:
            return self._read_secret(key, entry.secret_ref)

        if entry.formula is not None:
            if key in stack:
                raise CnosError(
                    f"cnos: unable to resolve derived config key {key} because of a recursive dependency on {key}"
                )
            if not entry.formula.runtime_dependent and entry.formula_cached:
                return entry.formula_cache, True
            next_stack = set(stack)
            next_stack.add(key)

            def resolve_ref(ref: str) -> Tuple[Any, bool]:
                return self._read_internal(ref, next_stack)

            value = evaluate_derived_formula(key, entry.formula, resolve_ref)
            if not entry.formula.runtime_dependent:
                entry.formula_cache = value
                entry.formula_cached = True
            return value, True

        return entry.value, True

    # -----------------------------------------------------------------------
    # Secret resolution
    # -----------------------------------------------------------------------

    def _read_secret(self, key: str, ref: SecretReference) -> Tuple[Any, bool]:
        self._validate_secret_ref_vault_provider(key, ref)

        if key in self._encrypted_secrets:
            return self._encrypted_secrets[key], True
        if key in self._hydrated_secrets:
            return self._hydrated_secrets[key], True

        definitions = self._secret_vault_definitions(ref)
        last_err: Optional[Exception] = None
        for definition in definitions:
            try:
                value, found = self._read_secret_with_definition(key, ref, definition)
                if found and value is not None:
                    self._hydrated_secrets[key] = value
                    return value, True
            except CnosError as exc:
                last_err = exc
                continue

        if last_err is not None:
            raise last_err

        self._hydrated_secrets[key] = None
        return None, True

    def _read_secret_with_definition(
        self, key: str, ref: SecretReference, definition: VaultDefinition
    ) -> Tuple[Any, bool]:
        if definition.provider in ("environment", "github-secrets"):
            return self._read_environment_secret_with_definition(ref, definition), True
        if definition.provider == "local":
            secrets = self._local_vault_secrets(ref.vault)
            value = secrets.get(ref.ref)
            if value is None:
                return None, True
            return value, True
        # Custom provider
        if definition.provider not in self._secret_factories:
            raise CnosError(f"cnos: unsupported vault provider: {definition.provider}")
        self._hydrate_custom_vault(
            ref.vault,
            definition,
            self._refs_for_vault_candidate(ref.vault, definition),
        )
        return self._hydrated_secrets.get(key), True

    def _secret_vault_definitions(self, ref: SecretReference) -> List[VaultDefinition]:
        definition = self._secret_vault_definition(ref)
        return [definition] + list(definition.fallback)

    def _secret_vault_definition(self, ref: SecretReference) -> VaultDefinition:
        if ref.vault in self._vaults:
            definition = _clone_vault_def(self._vaults[ref.vault])
            if not definition.provider:
                definition.provider = ref.provider or ""
            return definition
        provider = ref.provider or "local"
        return VaultDefinition(
            provider=provider,
            auth=VaultAuthDefinition(method=_default_vault_method(provider)),
            mapping={},
            fallback=[],
        )

    def _validate_secret_ref_vault_provider(self, key: str, ref: SecretReference) -> None:
        if not ref.vault or not ref.provider:
            return
        definition = self._vaults.get(ref.vault)
        if definition is None or not definition.provider or definition.provider == ref.provider:
            return
        raise CnosError(
            f'cnos: secret ref "{key}" declares provider "{ref.provider}" '
            f'but vault "{ref.vault}" uses provider "{definition.provider}"'
        )

    def _refs_for_vault_candidate(
        self, vault_id: str, definition: VaultDefinition
    ) -> Dict[str, str]:
        result: Dict[str, str] = {}
        for key, entry in self._entries.items():
            if entry is None or entry.secret_ref is None or entry.secret_ref.vault != vault_id:
                continue
            if key in self._hydrated_secrets:
                continue
            for candidate in self._secret_vault_definitions(entry.secret_ref):
                if candidate.provider == definition.provider:
                    result[key] = entry.secret_ref.ref
                    break
        return result

    def _hydrate_custom_vault(
        self,
        vault_id: str,
        definition: VaultDefinition,
        refs_by_logical_key: Dict[str, str],
    ) -> None:
        factory = self._secret_factories.get(definition.provider)
        if factory is None:
            raise CnosError(f"cnos: unsupported vault provider: {definition.provider}")

        unique_refs = sorted(set(refs_by_logical_key.values()))

        provider = factory.create(vault_id, definition)
        if provider is None:
            raise CnosError(
                f'cnos: create vault provider "{definition.provider}" for vault "{vault_id}" returned None'
            )

        auth = resolve_vault_auth(vault_id, definition, self._env)
        provider.authenticate(auth)

        values = provider.batch_get(unique_refs)

        for key, ref in refs_by_logical_key.items():
            if key in self._hydrated_secrets:
                continue
            if ref in values and values[ref] is not None:
                self._hydrated_secrets[key] = values[ref]

    def _read_environment_secret_with_definition(
        self, ref: SecretReference, definition: VaultDefinition
    ) -> Any:
        value, found = self._env.get(ref.ref)
        if found:
            return value
        if ref.env_var:
            value, found = self._env.get(ref.env_var)
            if found:
                return value
        for env_var, logical_ref in (definition.mapping or {}).items():
            if logical_ref == ref.ref:
                value, found = self._env.get(env_var)
                if found:
                    return value
                break
        return None

    def _local_vault_secrets(self, vault: str) -> Dict[str, str]:
        if vault in self._local_vault_cache:
            return self._local_vault_cache[vault]
        definition = self._vaults.get(vault)
        secrets = read_local_vault_secrets(self._secret_home, vault, definition, self._env)
        self._local_vault_cache[vault] = secrets
        return secrets

    def _warm_secrets(self) -> None:
        keys = sorted(
            key for key, entry in self._entries.items() if entry.secret_ref is not None
        )
        for key in keys:
            entry = self._entries.get(key)
            if entry is None or entry.secret_ref is None:
                continue
            self._read_secret(key, entry.secret_ref)

    def _with_secret_caches(
        self,
        hydrated_secrets: Dict[str, Any],
        local_vault_cache: Dict[str, Dict[str, str]],
    ) -> "CnosRuntime":
        copy = CnosRuntime(
            projection=self._projection,
            manifest=self._manifest,
            profile_source=self._profile_source,
            workspace_state=self._workspace_state,
            graph_bootstrapped=self._graph_bootstrapped,
            env=self._env,
            secret_home=self._secret_home,
            entries=self._entries,
            sources=self._sources,
            runtime_namespaces=self._runtime_namespaces,
            runtime_providers=self._runtime_providers,
            encrypted_secrets=self._encrypted_secrets,
            hydrated_secrets=hydrated_secrets,
            local_vault_cache=local_vault_cache,
            logical_key_to_vault=self._logical_key_to_vault,
            vaults=self._vaults,
            secret_factories=self._secret_factories,
        )
        return copy

    # -----------------------------------------------------------------------
    # Populate entries from projection
    # -----------------------------------------------------------------------

    def _populate_entries(self) -> None:
        explicit_namespaces: Set[str] = {"config", "flags", "process"}
        for namespace in self._projection.meta.namespaces:
            explicit_namespaces.add(namespace)

        workspace = self._projection.workspace
        meta_winner = RuntimeProvenance(
            source_id="server-projection", plugin_id="cnos", workspace_id=workspace
        )

        for raw_key, value in self._projection.values.items():
            logical_key = _projection_logical_key(raw_key, explicit_namespaces)
            self._entries[logical_key] = RuntimeEntry(
                key=logical_key,
                namespace=_namespace_for_key(logical_key),
                value=value,
                winner=RuntimeProvenance(source_id="server-projection", plugin_id="cnos", workspace_id=workspace),
            )
            self._sources[logical_key] = "server-projection"

        for raw_key, formula in self._projection.derived.items():
            logical_key = _projection_logical_key(raw_key, explicit_namespaces)
            parsed = parse_derived_formula(formula)
            self._entries[logical_key] = RuntimeEntry(
                key=logical_key,
                namespace=_namespace_for_key(logical_key),
                formula=parsed,
                winner=RuntimeProvenance(source_id="server-projection", plugin_id="cnos", workspace_id=workspace),
            )
            self._sources[logical_key] = "server-projection"

        for key, ref in self._projection.secret_refs.items():
            logical_key = _to_logical_key("secret", key)
            ref_copy = SecretReference(
                ref=ref.ref,
                provider=ref.provider,
                vault=ref.vault or "default",
                env_var=ref.env_var,
            )
            self._entries[logical_key] = RuntimeEntry(
                key=logical_key,
                namespace="secret",
                secret_ref=ref_copy,
                winner=RuntimeProvenance(source_id="server-projection", plugin_id="cnos", workspace_id=workspace),
            )
            self._sources[logical_key] = "server-projection"
            self._logical_key_to_vault[logical_key] = ref_copy.vault

        for key in self._projection.public_keys:
            source_key = key
            if source_key not in self._entries:
                source_key = _to_logical_key("value", key)
            if source_key not in self._entries:
                continue
            public_key = _to_logical_key("public", key)
            self._entries[public_key] = RuntimeEntry(
                key=public_key,
                namespace="public",
                alias_to=source_key,
                promoted_from=source_key,
                winner=RuntimeProvenance(source_id="server-projection", plugin_id="cnos", workspace_id=workspace),
            )
            self._sources[public_key] = "server-projection"

        # meta entries
        self._entries["meta.profile"] = RuntimeEntry(key="meta.profile", namespace="meta", value=self._projection.profile, winner=meta_winner)
        self._entries["meta.workspace"] = RuntimeEntry(key="meta.workspace", namespace="meta", value=self._projection.workspace, winner=meta_winner)
        self._entries["meta.cnos_version"] = RuntimeEntry(key="meta.cnos_version", namespace="meta", value=self._projection.meta.cnos_version, winner=meta_winner)
        self._sources["meta.profile"] = "server-projection"
        self._sources["meta.workspace"] = "server-projection"
        self._sources["meta.cnos_version"] = "server-projection"

    # -----------------------------------------------------------------------
    # Derived entry preparation
    # -----------------------------------------------------------------------

    def _prepare_derived_entries(self) -> None:
        keys = sorted(
            key for key, entry in self._entries.items() if entry.formula is not None
        )

        resolved: Set[str] = set()
        visiting: Set[str] = set()

        def visit(key: str) -> None:
            if key in resolved:
                return
            if key in visiting:
                raise CnosError(
                    f"cnos: unable to resolve derived config key {key} because of a recursive dependency on {key}"
                )

            entry = self._entries.get(key)
            if entry is None or entry.formula is None:
                resolved.add(key)
                return

            visiting.add(key)
            formula = entry.formula
            runtime_refs = list(formula.runtime_refs)
            runtime_dependent = formula.runtime_dependent

            for ref in formula.refs:
                namespace = _namespace_for_key(ref)
                if not namespace:
                    continue
                if namespace in self._runtime_namespaces:
                    runtime_dependent = True
                    runtime_refs.append(ref)
                    continue
                dep_entry = self._entries.get(ref)
                if dep_entry is not None and dep_entry.formula is not None:
                    visit(ref)
                    if dep_entry.formula.runtime_dependent:
                        runtime_dependent = True

            formula.runtime_refs = _unique_sorted_list(runtime_refs)
            formula.runtime_dependent = runtime_dependent
            formula.deps = filter_formula_deps(formula.refs, self._runtime_namespaces)
            visiting.discard(key)
            resolved.add(key)

        for key in keys:
            visit(key)

    def _initialize_runtime_providers(self, namespaces: List[str]) -> None:
        for namespace in namespaces:
            self._runtime_namespaces.add(namespace)
        if "process" in self._runtime_namespaces:
            self._runtime_providers["process"] = _default_process_provider(self._env)

    # -----------------------------------------------------------------------
    # Exports helpers
    # -----------------------------------------------------------------------

    def _profile_workspace(self, kind: str) -> str:
        if kind == "workspace":
            v, ok = self.meta("workspace")
            if ok and isinstance(v, str):
                return v
        elif kind == "profile":
            v, ok = self.meta("profile")
            if ok and isinstance(v, str):
                return v
        elif kind == "resolved_at":
            return self._projection.resolved_at
        return ""

    def _namespace_definition(self, namespace: str) -> Dict[str, Any]:
        if namespace in self._manifest["namespaces"]:
            return self._manifest["namespaces"][namespace]
        if namespace in _DEFAULT_NAMESPACE_DEFS:
            return _DEFAULT_NAMESPACE_DEFS[namespace]
        return {"kind": "data"}

    def _inspect_workspace_chain(self) -> List[str]:
        if self._workspace_state.chain:
            return list(self._workspace_state.chain)
        workspace = self._profile_workspace("workspace")
        if not workspace:
            return []
        return [workspace]

    def _inspect_derived(self, key: str, entry: RuntimeEntry) -> InspectDerived:
        formula = entry.formula
        assert formula is not None

        dependencies: List[InspectDependency] = []
        for ref in formula.refs:
            v, ok = self.read(ref)
            dep = InspectDependency(key=ref)
            if ok:
                dep.value = v
            ns = _namespace_for_key(ref)
            if ns in self._runtime_namespaces:
                dep.runtime_namespace = ns
            dependencies.append(dep)

        runtime_namespaces = _unique_sorted_list(
            [_namespace_for_key(ref) for ref in formula.runtime_refs if _namespace_for_key(ref)]
        )

        derived = InspectDerived(
            type=formula_type(formula),
            expression=formula.raw,
            dependencies=dependencies,
            runtime_dependent=formula.runtime_dependent,
            runtime_namespaces=runtime_namespaces,
        )
        if formula.runtime_dependent:
            derived.promotion_warning = "Cannot be promoted to browser/public."
        return derived

    def _resolve_projected_source_key(self, key: str) -> str:
        entry = self._entries.get(key)
        if entry is not None:
            if entry.alias_to:
                return entry.alias_to
            if entry.promoted_from:
                return entry.promoted_from
        if key.startswith("public."):
            fallback = "value." + key[len("public."):]
            if fallback in self._entries:
                return fallback
        return key

    def _logical_ref_to_mapped_env_var(self, vault_id: str, ref: str) -> str:
        vault_def = self._manifest["vaults"].get(vault_id)
        if vault_def is None:
            return ""
        mapping = getattr(vault_def, "mapping", None) or {}
        for env_var, logical_ref in mapping.items():
            if logical_ref == ref:
                return env_var
        return ""


# ---------------------------------------------------------------------------
# Process provider
# ---------------------------------------------------------------------------

def _default_process_provider(env: Environment) -> RuntimeProvider:
    def provider(path: str) -> Any:
        segments = path.split(".")
        if len(segments) > 1 and segments[0] == "env":
            env_key = ".".join(segments[1:])
            value, found = env.get(env_key)
            if found:
                return value
            return None
        if path == "cwd":
            return os.path.abspath(os.getcwd())
        if path == "platform":
            return node_platform()
        if path == "arch":
            return node_arch()
        if path == "pid":
            return os.getpid()
        return None
    return provider


# ---------------------------------------------------------------------------
# Projection logical key
# ---------------------------------------------------------------------------

def _projection_logical_key(raw: str, explicit_namespaces: Set[str]) -> str:
    if raw.startswith("value.") or raw.startswith("public."):
        return raw
    first = raw.split(".")[0]
    if first in explicit_namespaces:
        return raw
    return _to_logical_key("value", raw)


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _clone_any_map(source: Dict[str, Any]) -> Dict[str, Any]:
    return dict(source)


def _clone_local_vault_cache(source: Dict[str, Dict[str, str]]) -> Dict[str, Dict[str, str]]:
    return {vault: dict(secrets) for vault, secrets in source.items()}


def _secret_vault_factory_map(
    factories: List[SecretVaultProviderFactory],
) -> Dict[str, SecretVaultProviderFactory]:
    result: Dict[str, SecretVaultProviderFactory] = {}
    for factory in factories:
        provider = (factory.provider or "").strip()
        if not provider or factory.create is None:
            continue
        result[provider] = factory
    return result


# ---------------------------------------------------------------------------
# Factory functions
# ---------------------------------------------------------------------------

def new_runtime(
    source: bytes,
    env: Environment,
    secret_home: str,
    factories: List[SecretVaultProviderFactory],
) -> CnosRuntime:
    projection = parse_projection(source)
    encrypted_secrets = decrypt_secret_payload_from_env(env)
    manifest = _bootstrapped_manifest_from_projection(projection)

    runtime = CnosRuntime(
        projection=projection,
        manifest=manifest,
        profile_source="manifest-default",
        workspace_state=new_implicit_workspace_state(projection.workspace),
        graph_bootstrapped=False,
        env=env,
        secret_home=secret_home,
        entries={},
        sources={},
        runtime_namespaces=set(),
        runtime_providers={},
        encrypted_secrets=encrypted_secrets,
        hydrated_secrets={},
        local_vault_cache={},
        logical_key_to_vault={},
        vaults=dict(manifest["vaults"]),
        secret_factories=_secret_vault_factory_map(factories),
    )
    runtime._populate_entries()
    runtime._initialize_runtime_providers(projection.runtime_namespaces)
    runtime._prepare_derived_entries()
    return runtime


def new_runtime_from_graph(
    source: bytes,
    env: Environment,
    secret_home: str,
    factories: List[SecretVaultProviderFactory],
) -> CnosRuntime:
    graph = parse_runtime_graph(source)
    encrypted_secrets = decrypt_secret_payload_from_env(env)
    manifest = _bootstrapped_manifest_from_graph(graph)

    runtime = CnosRuntime(
        projection=ServerProjection(
            version=1,
            workspace=graph.workspace.workspace_id,
            profile=graph.profile,
            resolved_at=graph.resolved_at,
            config_hash="",
            values={},
            derived={},
            secret_refs={},
            vaults={},
            public_keys=[],
            runtime_namespaces=[],
            meta=ProjectionMeta(
                workspace=graph.workspace.workspace_id,
                profile=graph.profile,
                cnos_version="graph-bootstrap",
            ),
        ),
        manifest=manifest,
        profile_source=graph.profile_source,
        workspace_state=InspectWorkspaceState(
            id=graph.workspace.workspace_id,
            source=graph.workspace.workspace_source,
            chain=list(graph.workspace.workspace_chain),
        ),
        graph_bootstrapped=True,
        env=env,
        secret_home=secret_home,
        entries={},
        sources={},
        runtime_namespaces=set(),
        runtime_providers={},
        encrypted_secrets=encrypted_secrets,
        hydrated_secrets={},
        local_vault_cache={},
        logical_key_to_vault={},
        vaults=dict(manifest["vaults"]),
        secret_factories=_secret_vault_factory_map(factories),
    )

    for resolved in graph.entries:
        entry = _runtime_entry_from_graph(resolved)
        runtime._entries[resolved.key] = entry
        runtime._sources[resolved.key] = resolved.winner.source_id
        if entry.secret_ref is not None and entry.secret_ref.vault:
            runtime._logical_key_to_vault[resolved.key] = entry.secret_ref.vault

    runtime_namespaces = sorted(manifest["runtime_namespaces"].keys())
    runtime._initialize_runtime_providers(runtime_namespaces)
    runtime._prepare_derived_entries()
    return runtime
