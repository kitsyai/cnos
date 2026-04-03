---
id: PLUGIN-EXPORT-1
short_id: b0c2377904d2
title: Implement env export and public projection plugin
type: feature
status: done
created: 2026-04-03
updated: 2026-04-03
aliases: []
priority: p2
track: v1
depends_on:
  - CORE-ORCH-2
delivery: v1
acceptance:
  - plugins/env-export exposes workspace-aware toEnv() and toPublicEnv() modules
    driven by ResolvedGraph, envMapping, and public promotion rules from the
    authoritative manifest.
  - packages/core and packages/cnos expose runtime projection APIs backed by the
    exporter plugins, and add dump/materialization foundation for selected
    workspaces.
  - Public projection includes only declared value.* keys, rejects any secret.*
    promotion attempt, and supports Next, Vite, Nuxt, and explicit custom prefix
    overrides.
  - Tests cover logical-to-env conversion, namespace filtering, workspace-aware
    export behavior, public promotion safety, framework prefixes, and dump
    snapshot determinism.
tests_required:
  - Unit tests for env projection helpers, public filtering rules, and dump path
    planning.
  - Integration tests for runtime toEnv()/toPublicEnv() output and dump
    snapshots from resolved workspace fixture graphs.
origin:
  authority_refs:
    - docs/cnos-spec.md
    - docs/cnos-prompt-pack.md
  derived_refs:
    - docs/cnos-workspace.md
---
Build the export and dump surface in plugins/env-export and hook it into the
workspace-aware runtime projection APIs from packages/core and packages/cnos.
