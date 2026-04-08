---
id: CLI-CODEGEN-1
short_id: c9b127760b2f
title: Typed config code generation from schema
type: feature
status: done
created: 2026-04-08
updated: 2026-04-08
aliases: []
priority: p1
track: v1
delivery: v1-3
acceptance:
  - cnos codegen writes .cnos/types/cnos.d.ts and .cnos/types/runtime.ts from
    normalized schema.
  - Generated TypeScript groups value.* and secret.* keys, maps CNOS schema
    types correctly, and falls back gracefully when schema is empty or missing.
  - cnos codegen --out writes a custom file target, and --watch regenerates on
    manifest/schema change.
tests_required:
  - Unit tests cover schema type mapping, empty schema fallback, and generated
    content shape.
  - CLI/integration tests cover default output, custom output, watch
    regeneration, and generated types compiling without errors.
origin:
  authority_refs:
    - docs/cnos-spec.md
    - docs/cnos-changeset-1.3.md
  derived_refs:
    - docs/cnos-v1-complete-test-suite.md
---
