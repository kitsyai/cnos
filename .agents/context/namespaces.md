# Namespace Reference

Namespaces define what kind of data a key represents and which surfaces may read or export it.

## Built-in Namespaces

- `value.*`: normal config data
- `secret.*`: sensitive secret refs and hydrated secret reads
- `meta.*`: system-populated readonly metadata
- `public.*`: projection namespace created by promotion
- `process.*`: built-in runtime namespace
- `var.*`: mutable, non-secret runtime configuration owned by a remote authority (allow/block lists, entitlements, kill switches). Keys are `var.<group>.<rest>`; the manifest maps `<group>` to a declared `varSources` entry. Reads resolve through an overlay: active runtime revision → static `value.<group>.<rest>` → schema `default`. See `.agents/context/runtime-vars.md`.

## Custom Namespaces

The manifest can declare:

- custom data namespaces such as `flags.*` or `config.*`
- custom runtime namespaces such as `request.*` or `session.*`

Data namespaces participate in storage and resolution. Runtime namespaces are supplied by the host process at read time.

## Safety Rules

- `secret.*` must never appear in browser/public surfaces.
- Namespaces marked `sensitive: true` follow the same restriction.
- `public.*` is output-only. Agents should not model it as an authoring namespace.
- `process.*` and custom runtime namespaces are server/runtime-only and should not be promoted into browser/public outputs when they remain runtime-dependent.
- `var.*` must never appear in `public.promote`, browser projections, or `toPublicEnv()` output — enforced at manifest validation (`var.public-exposure`). A `var.*` document may carry an opaque `secret.*` reference, never secret material. `varStatus()`, `cnos var status`, `cnos var history`, and the append-only var log never expose secret material or full sensitive documents.

## Derived Values

- You may author derived values in `value.*` and other writable data namespaces.
- You may not author derived values in `secret.*`, `public.*`, `meta.*`, or runtime namespaces (this includes `var.*` — it is a read-only overlay, not an authoring namespace).
- Derived expressions may reference `value.*`, `meta.*`, shareable custom data namespaces, runtime namespaces, and `var.*`.
- Derived expressions may not reference `secret.*` or `public.*`.
- Any derivation that references `var.*` is runtime-dependent by definition and is never cached (Critical Rule 9), re-evaluated on every read.

## CLI Notes

- `cnos value ...` operates on `value.*`.
- `cnos secret ...` operates on `secret.*`.
- `cnos define <value|secret> ...` routes through write policy.
- `cnos list <namespace>` can inspect a namespace-specific view of the resolved graph.

For the live CLI surface, trust `cnos help-ai --format json`.
