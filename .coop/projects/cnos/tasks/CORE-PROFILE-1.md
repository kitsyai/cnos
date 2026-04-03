---
id: CORE-PROFILE-1
short_id: 37302c9fb4b3
title: Implement profile graph expansion, inherited resolution, and inspection
type: feature
status: todo
created: 2026-04-03
updated: 2026-04-03
aliases: []
priority: p2
track: v1
depends_on:
  - PLUGIN-LOAD-2
delivery: v1
acceptance:
  - packages/core resolves the active profile via CLI override, CNOS_PROFILE,
    then manifest default and expands inheritance chains with hard errors on
    cycles.
  - The profile-aware resolver applies parent layers before child layers and
    records sufficient provenance to identify winner and overridden entries.
  - Inspection APIs report final value, profile source, winner origin, and
    overridden values in a stable structured shape consumable by the CLI.
  - Tests cover profile selection priority, inheritance order, cycle detection,
    inspect winner/override chains, and missing-key behavior under profile-aware
    resolution.
tests_required:
  - Unit tests for resolveActiveProfile and expandProfileChain cycle handling.
  - Integration tests for inherited profile fixtures and inspect/provenance
    output.
origin:
  authority_refs:
    - docs/cnos-v1-canonical-spec.md
    - docs/cnos-v1-codex-bootstrap-prompt.md
---
Extend packages/core with profile selection, inheritance-aware resolution, and provenance inspection while using the current package folder names.