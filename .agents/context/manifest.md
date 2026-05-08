# Manifest Reference

The manifest lives at `.cnos/cnos.yml`. It is the structural source of truth for:

- project identity
- workspaces and global root settings
- profile defaults and activation order
- plugin/source configuration
- resolution precedence
- env export mappings
- public promotion rules
- namespace declarations
- vault definitions
- write policy
- schema rules

## Rule Of Thumb

If a change affects how CNOS is shaped rather than what one resolved value happens to be, it probably belongs in the manifest model.

## Important Sections

- `project`: repo/service identity
- `workspaces`: default workspace, declared workspaces, global-root settings
- `profiles`: default profile and profile activation order
- `plugins` / `sources`: loader-validator-exporter configuration
- `resolution`: precedence and array merge policy
- `envMapping`: explicit env export mappings
- `public`: promoted browser-safe keys and framework prefixes
- `namespaces`: custom data/runtime namespace declarations
- `vaults`: secret provider configuration and auth rules
- `writePolicy`: where CLI writes land
- `schema`: validation rules keyed by logical key

## Agent Guidance

- Manifest type definitions live in `packages/core/src/types/manifest.ts`.
- Manifest normalization lives in `packages/core/src/manifest/normalizeManifest.ts`.
- Backward compatibility matters. New fields should normalize cleanly when omitted.
- `profiles.default` is a profile name such as `local`, never `base`.
- `base` is a workspace convention, not a profile.
- When the manifest shape changes, update:
  - core types
  - normalization
  - any affected validation/resolution logic
  - `.agents` context that describes the feature
  - published docs in `packages/docs/docs/reference/manifest.mdx`
