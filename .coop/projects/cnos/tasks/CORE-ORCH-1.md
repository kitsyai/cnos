---
id: CORE-ORCH-1
short_id: 76d0fcd7e657
title: Implement core domain model, manifest loading, and runtime baseline
type: feature
status: todo
created: 2026-04-03
updated: 2026-04-03
aliases: []
priority: p2
track: v1
delivery: v1
acceptance:
  - packages/core defines the canonical CNOS v1 domain types, plugin contracts,
    manifest types, and normalized manifest loading aligned to
    docs/cnos-v1-canonical-spec.md sections 5 through 8 and 17.
  - packages/core provides the baseline orchestrator and runtime pipeline with
    flat resolution, meta namespace population, and runtime reads via read(),
    require(), and readOr().
  - packages/cnos exposes a batteries-included createCnos(...) entry wired to
    packages/core without collapsing plugin boundaries.
  - Tests cover manifest load and invalid-manifest failure paths, flat baseline
    resolution behavior, runtime read semantics, and meta key population.
tests_required:
  - Unit tests for core types, manifest normalization, runtime helpers, and meta
    namespace generation.
  - Integration tests for createCnos() bootstrapping against fixture manifests
    and seeded entries.
origin:
  authority_refs:
    - docs/cnos-v1-canonical-spec.md
    - docs/cnos-v1-codex-bootstrap-prompt.md
  derived_refs: []
---
Implement the CNOS v1 core in the current workspace layout: packages/core, packages/cnos, packages/cli, and plugins/* instead of the older folder names used in the docs.