---
id: CLI-ORCH-1
short_id: 9fdedcd86568
title: Implement foundational CLI commands and project scaffolding
type: feature
status: todo
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
    cnos inspect against the current runtime APIs in packages/core and
    packages/cnos.
  - cnos init scaffolds the starter cnos tree and required .gitignore entries
    without mutating unrelated repository files.
  - Read and inspect commands support deterministic human-readable and JSON
    output, including profile selection where specified by the spec.
  - Tests cover init scaffolding, read/value/secret lookups, inspect text/json
    output, and error cases for missing keys or missing project files.
tests_required:
  - Unit tests for CLI argument routing and output formatting helpers.
  - Integration tests invoking the built CLI against fixture workspaces for
    init, read, aliases, and inspect.
origin:
  authority_refs:
    - docs/cnos-v1-canonical-spec.md
    - docs/cnos-v1-codex-bootstrap-prompt.md
---
Build the initial command surface in packages/cli using the runtime and plugin APIs from the implemented packages.