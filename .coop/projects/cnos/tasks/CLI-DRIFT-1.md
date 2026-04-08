---
id: CLI-DRIFT-1
short_id: c25727571e66
title: Schema drift reporting and env file bridge polish
type: feature
status: done
created: 2026-04-08
updated: 2026-04-08
aliases: []
priority: p2
track: v1
delivery: v1-3
acceptance:
  - cnos drift compares schema against the resolved graph and reports missing
    required keys, undeclared keys, type mismatches, and defaults applied.
  - Drift output is human-readable by default and workspace/profile aware.
  - env export file-writing support remains covered alongside drift reporting so
    .env generation stays deterministic and tested.
tests_required:
  - Unit tests cover schema-to-graph comparison categories and report formatting.
  - CLI/integration tests cover drift output across profiles/workspaces and env
    export --to file formatting.
origin:
  authority_refs:
    - docs/cnos-spec.md
    - docs/cnos-changeset-1.3.md
  derived_refs:
    - docs/cnos-v1-complete-test-suite.md
---
