---
id: PLUGIN-LOAD-1
short_id: ffadde96bdfb
title: Implement filesystem loaders for values and secrets
type: feature
status: done
created: 2026-04-03
updated: 2026-04-03
aliases: []
priority: p2
track: v1
depends_on:
  - CORE-ORCH-1
delivery: v1
acceptance:
  - plugins/filesystem exposes separate filesystem-values and filesystem-secrets
    loader modules that return ConfigEntry arrays with origin metadata and
    preserve plugin boundaries.
  - Files under cnos/values map only to value.* keys and files under
    cnos/secrets map only to secret.* keys, with deterministic flattening from
    nested YAML paths.
  - Filesystem loaders integrate with the baseline resolver and packages/cnos
    assembly without moving loader logic into packages/core.
  - Tests cover nested YAML flattening, namespace assignment, origin provenance,
    precedence across base and profile files, and malformed input handling.
tests_required:
  - Unit tests for flattening helpers and namespace-to-directory mapping.
  - Integration tests using fixture cnos/values and cnos/secrets trees across
    base and profile-specific files.
origin:
  authority_refs:
    - docs/cnos-spec.md
    - docs/cnos-prompt-pack.md
  derived_refs:
    - docs/cnos-workspace.md
---
Build the filesystem loader package under plugins/filesystem with separate loader modules for value and secret sources.