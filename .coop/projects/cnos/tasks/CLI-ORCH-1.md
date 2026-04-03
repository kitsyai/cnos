---
id: CLI-ORCH-1
short_id: 9fdedcd86568
title: Implement foundational CLI commands and project scaffolding
type: feature
status: done
created: 2026-04-03
updated: 2026-04-03
aliases: []
priority: p2
track: v1
depends_on:
  - PLUGIN-EXPORT-1
delivery: v1
acceptance:
  - packages/cli implements cnos init, cnos read, cnos value, cnos secret, and
    cnos inspect against the workspace-aware runtime APIs in packages/core and
    packages/cnos.
  - All implemented commands support deterministic parsing and propagation of
    --workspace, --profile, and --global-root where relevant.
  - cnos init scaffolds the workspace-aware starter tree, .cnos-workspace.yml
    example, and required .gitignore entries without mutating unrelated
    repository files.
  - Tests cover init scaffolding, read/value/secret lookups, inspect text/json
    output, workspace-aware provenance, and error cases for missing keys or
    missing project files.
tests_required:
  - Unit tests for CLI argument routing and output formatting helpers.
  - Integration tests invoking the built CLI against fixture workspaces for
    init, read, aliases, and inspect.
origin:
  authority_refs:
    - docs/cnos-spec.md
    - docs/cnos-prompt-pack.md
  derived_refs:
    - docs/cnos-workspace.md
---
Build the initial workspace-aware command surface in packages/cli using the
runtime and plugin APIs from the implemented packages.
