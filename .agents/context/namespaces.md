# Namespace Reference

Namespaces define what kind of data a key represents and which surfaces may read or export it.

## Built-in Namespaces

- `value.*`: normal config data
- `secret.*`: sensitive secret refs and hydrated secret reads
- `meta.*`: system-populated readonly metadata
- `public.*`: projection namespace created by promotion
- `process.*`: built-in runtime namespace

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

## Derived Values

- You may author derived values in `value.*` and other writable data namespaces.
- You may not author derived values in `secret.*`, `public.*`, `meta.*`, or runtime namespaces.
- Derived expressions may reference `value.*`, `meta.*`, shareable custom data namespaces, and runtime namespaces.
- Derived expressions may not reference `secret.*` or `public.*`.

## CLI Notes

- `cnos value ...` operates on `value.*`.
- `cnos secret ...` operates on `secret.*`.
- `cnos define <value|secret> ...` routes through write policy.
- `cnos list <namespace>` can inspect a namespace-specific view of the resolved graph.

For the live CLI surface, trust `cnos help-ai --format json`.
