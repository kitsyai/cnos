---
id: CORE-VALIDATE-1
short_id: 0a812c74645a
title: Implement schema validation, public safety validation, and v1 polish
type: feature
status: todo
created: 2026-04-03
updated: 2026-04-03
aliases: []
priority: p2
track: v1
depends_on:
  - CLI-ORCH-2
delivery: v1
acceptance:
  - packages/core implements the basic schema validator for type, required,
    enum, pattern, and default behavior plus public safety validation for
    invalid promotions.
  - The repository documentation, starter fixtures, and examples reflect the
    implemented runtime and CLI behavior using packages/core, packages/cnos,
    packages/cli, and plugins/* folder names.
  - The workspace test suite includes unit, integration, and golden coverage for
    runtime, plugins, and CLI surfaces needed to guard the shipped v1 behavior.
  - Tests cover invalid schema failures, coercion/default application, public
    safety errors, starter example smoke flow, and golden snapshots for CLI
    inspection/export output.
tests_required:
  - Unit tests for schema keyword handling and validation diagnostics.
  - Integration and golden tests covering end-to-end runtime plus CLI flows from
    starter/example fixtures.
origin:
  authority_refs:
    - docs/cnos-v1-canonical-spec.md
    - docs/cnos-v1-codex-bootstrap-prompt.md
---
Finalize the v1 implementation with validator coverage, examples, and regression protection across the current monorepo layout.