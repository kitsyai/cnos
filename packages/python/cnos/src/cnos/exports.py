"""Export helpers — to_object, to_namespace, to_env, to_public_env, to_server_projection,
format_message, log_message, config_hash. Mirrors Go's exports.go.
These are implemented as free functions that accept a CnosRuntime instance.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Set, Tuple

from cnos.errors import CnosError
from cnos.jscompat import js_log_stringify_value, js_stringify_value
from cnos.projection import ServerProjection
from cnos.types import (
    DerivedFormula,
    SecretReference,
    ToEnvOptions,
    ToPublicEnvOptions,
    VaultDefinition,
)

if TYPE_CHECKING:
    from cnos.runtime import CnosRuntime

_TEMPLATE_PATTERN = re.compile(r"\$\{([^}]+)\}")

_SAFE_PROJECTED_CONFIG_KEYS: Set[str] = {
    "address", "audience", "clientid", "endpoint", "mount", "namespace",
    "path", "projectid", "region", "scope", "scopes", "serviceaccountemail",
    "tenant", "tenantid", "url", "version", "vaulturl",
}


# ---------------------------------------------------------------------------
# to_object / to_namespace
# ---------------------------------------------------------------------------

def to_object(runtime: "CnosRuntime") -> Dict[str, Any]:
    return _to_namespace_object(runtime, "")


def to_namespace(runtime: "CnosRuntime", namespace: str) -> Dict[str, Any]:
    return _to_namespace_object(runtime, namespace.strip())


def _to_namespace_object(runtime: "CnosRuntime", namespace: str) -> Dict[str, Any]:
    output: Dict[str, Any] = {}
    keys = sorted(runtime._entries.keys())
    for key in keys:
        entry = runtime._entries[key]
        if entry is None:
            continue
        if namespace and entry.namespace != namespace:
            continue
        value, ok = runtime.read(key)
        if not ok:
            continue
        target_path = key if not namespace else key[len(namespace) + 1:]
        _set_nested_value(output, target_path.split("."), value)
    return output


def _set_nested_value(target: Dict[str, Any], path: List[str], value: Any) -> None:
    if not path or not path[0]:
        return
    head = path[0]
    if len(path) == 1:
        target[head] = value
        return
    current = target.get(head)
    if not isinstance(current, dict):
        current = {}
        target[head] = current
    _set_nested_value(current, path[1:], value)


# ---------------------------------------------------------------------------
# to_env
# ---------------------------------------------------------------------------

def to_env(runtime: "CnosRuntime", options: Optional[ToEnvOptions] = None) -> Dict[str, str]:
    config = options or ToEnvOptions()
    output: Dict[str, str] = {}
    explicit: Dict[str, str] = runtime._manifest.get("env_mapping", {}).get("explicit", {})
    for env_var in sorted(explicit.keys()):
        logical_key = explicit[env_var]
        entry = runtime._entries.get(logical_key)
        if entry is None:
            continue
        definition = runtime._namespace_definition(entry.namespace)
        if definition.get("kind") != "data":
            continue
        if entry.namespace == "secret":
            if not config.include_secrets:
                continue
        elif not definition.get("shareable") or definition.get("sensitive"):
            continue
        value, ok = runtime.read(logical_key)
        if not ok or value is None:
            continue
        output[env_var] = _normalize_env_value(value)
    return output


# ---------------------------------------------------------------------------
# to_public_env
# ---------------------------------------------------------------------------

def to_public_env(
    runtime: "CnosRuntime", options: Optional[ToPublicEnvOptions] = None
) -> Dict[str, str]:
    config = options or ToPublicEnvOptions()
    prefix = _resolve_public_prefix(runtime, config)
    output: Dict[str, str] = {}
    keys = sorted(
        k for k, e in runtime._entries.items() if e is not None and e.namespace == "public"
    )
    for key in keys:
        source_key = runtime._resolve_projected_source_key(key)
        source = runtime._entries.get(source_key)
        if source is not None and source.formula is not None and source.formula.runtime_dependent:
            value, ok = runtime.read(key)
            if not ok or value is None:
                raise CnosError(
                    f"cnos: cannot build public output for {key} because it depends on runtime-only values"
                )
        value, ok = runtime.read(key)
        if not ok or value is None:
            continue
        base_env_var = _fallback_public_env_var(key[len("public."):])
        env_var = base_env_var
        if prefix and not base_env_var.startswith(prefix):
            env_var = prefix + base_env_var
        output[env_var] = _normalize_env_value(value)
    return output


def _resolve_public_prefix(runtime: "CnosRuntime", options: ToPublicEnvOptions) -> str:
    if options.prefix:
        return options.prefix
    if not options.framework:
        return ""
    frameworks = runtime._manifest.get("frameworks", {})
    if options.framework not in frameworks:
        raise CnosError(f"cnos: unknown public framework prefix: {options.framework}")
    return frameworks[options.framework]


def _fallback_public_env_var(value_path: str) -> str:
    """Convert a dot-path to UPPER_SNAKE_CASE env var name. Mirrors Go's fallbackPublicEnvVar."""
    parts: List[str] = []
    last_underscore = False
    for i, ch in enumerate(value_path):
        if "a" <= ch <= "z":
            # Check if next char is uppercase (camelCase transition)
            if i > 0 and _last_was_lower_alpha_num(value_path, i - 1) and _is_upper_ahead(value_path, i):
                if not last_underscore:
                    parts.append("_")
            parts.append(ch.upper())
            last_underscore = False
        elif "A" <= ch <= "Z":
            if i > 0 and _last_was_lower_alpha_num(value_path, i - 1) and not last_underscore:
                parts.append("_")
            parts.append(ch)
            last_underscore = False
        elif "0" <= ch <= "9":
            parts.append(ch)
            last_underscore = False
        else:
            if not last_underscore:
                parts.append("_")
                last_underscore = True
    result = "".join(parts).strip("_")
    return result


def _last_was_lower_alpha_num(value: str, index: int) -> bool:
    if index < 0 or index >= len(value):
        return False
    ch = value[index]
    return ("a" <= ch <= "z") or ("0" <= ch <= "9")


def _is_upper_ahead(value: str, index: int) -> bool:
    if index + 1 >= len(value):
        return False
    return "A" <= value[index + 1] <= "Z"


# ---------------------------------------------------------------------------
# to_server_projection
# ---------------------------------------------------------------------------

def to_server_projection(runtime: "CnosRuntime") -> ServerProjection:
    if runtime._graph_bootstrapped:
        raise CnosError(
            "cnos: runtime graph bootstrap payload does not support server projection export"
        )
    proj = runtime._projection
    if proj.version == 1 and proj.resolved_at and proj.config_hash:
        return proj

    values: Dict[str, Any] = {}
    derived: Dict[str, DerivedFormula] = {}
    secret_refs: Dict[str, SecretReference] = {}
    public_keys: List[str] = []
    namespaces: Set[str] = set()
    rt_namespaces: Set[str] = set()

    keys = sorted(runtime._entries.keys())
    for key in keys:
        entry = runtime._entries.get(key)
        if entry is None or entry.namespace in ("meta", "public"):
            continue
        if entry.secret_ref is not None:
            ref = SecretReference(
                ref=entry.secret_ref.ref,
                provider=entry.secret_ref.provider or runtime._secret_vault_definition(entry.secret_ref).provider,
                vault=entry.secret_ref.vault,
                env_var=entry.secret_ref.env_var or runtime._logical_ref_to_mapped_env_var(entry.secret_ref.vault, entry.secret_ref.ref),
            )
            secret_refs[key[len("secret."):]] = ref
            continue
        definition = runtime._namespace_definition(entry.namespace)
        if definition.get("kind") != "data" or definition.get("sensitive"):
            continue
        if runtime._sources.get(key) == "process-env":
            continue
        projected_key = key
        if entry.namespace == "value":
            projected_key = key[len("value."):]
        else:
            namespaces.add(entry.namespace)

        if entry.formula is not None:
            if entry.formula.runtime_dependent:
                derived[projected_key] = DerivedFormula(
                    expr=entry.formula.raw,
                    deps=list(entry.formula.deps),
                    runtime_refs=list(entry.formula.runtime_refs),
                )
                for ref in entry.formula.runtime_refs:
                    ns = ref.split(".")[0] if "." in ref else ""
                    if ns:
                        rt_namespaces.add(ns)
                continue

        value, ok = runtime.read(key)
        if not ok:
            continue
        values[projected_key] = value

    for key in keys:
        entry = runtime._entries.get(key)
        if entry is not None and entry.namespace == "public":
            public_keys.append(key[len("public."):])

    namespace_list = sorted(n for n in namespaces if n)
    rt_namespace_list = sorted(n for n in rt_namespaces if n)

    # Collect referenced vaults
    referenced_vaults: Dict[str, VaultDefinition] = {}
    for ref in secret_refs.values():
        if ref.vault and ref.vault in runtime._vaults:
            referenced_vaults[ref.vault] = runtime._vaults[ref.vault]

    resolved_at = proj.resolved_at
    if not resolved_at:
        resolved_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    new_proj = ServerProjection(
        version=1,
        workspace=runtime._profile_workspace("workspace") or proj.workspace,
        profile=runtime._profile_workspace("profile") or proj.profile,
        resolved_at=resolved_at,
        config_hash=config_hash(values),
        values=_stable_sort_any_map(values),
        derived={k: derived[k] for k in sorted(derived)},
        secret_refs={k: secret_refs[k] for k in sorted(secret_refs)},
        vaults={k: referenced_vaults[k] for k in sorted(referenced_vaults)},
        public_keys=public_keys,
        runtime_namespaces=rt_namespace_list,
        meta=runtime._projection.meta.__class__(
            workspace=runtime._profile_workspace("workspace") or proj.workspace,
            profile=runtime._profile_workspace("profile") or proj.profile,
            cnos_version=_first_non_empty(proj.meta.cnos_version, "authoring-runtime"),
            namespaces=namespace_list,
        ),
    )
    runtime._projection = new_proj
    return new_proj


def _first_non_empty(*values: str) -> str:
    for v in values:
        if v and v.strip():
            return v.strip()
    return ""


# ---------------------------------------------------------------------------
# format_message / log_message
# ---------------------------------------------------------------------------

def format_message(runtime: "CnosRuntime", message: str) -> str:
    error: Optional[str] = None

    def replacer(match: re.Match) -> str:
        nonlocal error
        if error:
            return match.group(0)
        key = match.group(1).strip()
        if not key:
            return match.group(0)
        value, ok = runtime.read(key)
        if not ok:
            return match.group(0)
        return js_log_stringify_value(value)

    result = _TEMPLATE_PATTERN.sub(replacer, message)
    return result


def log_message(runtime: "CnosRuntime", message: str) -> str:
    formatted = format_message(runtime, message)
    print(formatted)
    return formatted


# ---------------------------------------------------------------------------
# config_hash
# ---------------------------------------------------------------------------

def config_hash(values: Dict[str, Any]) -> str:
    stable = _stable_json_string(values)
    return hashlib.sha256(stable.encode("utf-8")).hexdigest()


def _stable_json_string(values: Dict[str, Any]) -> str:
    try:
        return json.dumps(_stable_sort_any_map(values), separators=(",", ":"), sort_keys=True)
    except (TypeError, ValueError):
        return "{}"


def _stable_sort_any_map(value: Dict[str, Any]) -> Dict[str, Any]:
    sorted_map: Dict[str, Any] = {}
    for k in sorted(value.keys()):
        sorted_map[k] = _stable_sort_any_value(value[k])
    return sorted_map


def _stable_sort_any_value(value: Any) -> Any:
    if isinstance(value, dict):
        return _stable_sort_any_map(value)
    if isinstance(value, list):
        return [_stable_sort_any_value(item) for item in value]
    return value


def _normalize_env_value(value: Any) -> str:
    return js_stringify_value(value)
