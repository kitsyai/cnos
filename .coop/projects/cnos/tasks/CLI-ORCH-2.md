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
    dump, cnos run --, cnos diff, and cnos doctor as described in the
    workspace-integrated canonical spec.
  - define routes writes deterministically by writePolicy, defaults to the local
    selected workspace, and supports explicit --target global only when
    workspaces.global.allowWrite is enabled.
  - dump supports both workspace-preserving and --flatten snapshot modes, while
    export env remains env-only projection.
  - run injects resolved env into child processes, diff compares selected
    workspace/profile outputs in text and JSON formats, and doctor reports
    repository, workspace, global-root, and config health issues.
  - Tests cover define value/secret round-trips, explicit global writes, export
    flags including public/framework/profile/json, dump modes, run env injection
    and exit code propagation, diff output, and doctor diagnostics.
tests_required:
  - Unit tests for write-policy routing, dump planning, diff formatting, and
    doctor rule evaluation.
  - Integration tests invoking the built CLI against fixture workspaces for
    define, export, dump, run, diff, validate, and doctor.
origin:
  authority_refs:
    - docs/cnos-spec.md
    - docs/cnos-prompt-pack.md
  derived_refs:
    - docs/cnos-workspace.md
---
Finish the operational workspace-aware CLI surface in packages/cli with
deterministic local/global write policy handling, dump support, and
runtime-backed process execution.
