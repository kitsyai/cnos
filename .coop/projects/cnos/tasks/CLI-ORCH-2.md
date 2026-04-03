---
id: CLI-ORCH-2
short_id: a387cf2f6a3e
title: Implement write, validate, export, run, diff, and doctor CLI commands
type: feature
status: todo
created: 2026-04-03
updated: 2026-04-03
aliases: []
priority: p2
track: v1
depends_on:
  - CLI-ORCH-1
delivery: v1
acceptance:
  - packages/cli implements cnos define, cnos validate, cnos export env, cnos
    run --, cnos diff, and cnos doctor as described in the canonical spec.
  - define routes writes deterministically by writePolicy, performs
    namespace/path safety checks, creates files as needed, and round-trips
    through runtime reads.
  - run injects resolved env into child processes, diff compares profile outputs
    in text and JSON formats, and doctor reports repository and config health
    issues.
  - Tests cover define value/secret round-trips, export flags including
    public/framework/profile/json, run env injection and exit code propagation,
    diff output, and doctor diagnostics.
tests_required:
  - Unit tests for write-policy routing, diff formatting, and doctor rule
    evaluation.
  - Integration tests invoking the built CLI against fixture workspaces for
    define, export, run, diff, validate, and doctor.
origin:
  authority_refs:
    - docs/cnos-v1-canonical-spec.md
    - docs/cnos-v1-codex-bootstrap-prompt.md
---
Finish the operational CLI surface in packages/cli with deterministic write policy handling and runtime-backed process execution.