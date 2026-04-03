---
id: CORE-ORCH-2
short_id: a3a26d353b97
title: Implement workspace context, discovery, and multi-root loader foundation
type: feature
status: done
created: 2026-04-03
updated: 2026-04-03
aliases: []
priority: p2
track: v1
delivery: v1
acceptance:
  - packages/core implements WorkspaceContext, .cnos-workspace.yml loading,
    manifest workspace normalization, workspace selection precedence,
    global-root precedence, and workspace chain expansion with cycle detection.
  - LoaderContext is rebased from a single cnosRoot to manifestRoot plus
    workspace-aware root ordering, and ConfigEntry/ResolvedGraph/InspectResult
    carry workspace-aware provenance and metadata.
  - filesystem-values, filesystem-secrets, and dotenv load from ordered
    workspace roots with deterministic local-over-global and parent-before-child
    behavior.
  - Tests cover workspace selection precedence, global-root resolution,
    workspace chain ordering, cycle detection, local-only mode,
    local-over-global layering, and workspace meta/provenance output.
tests_required:
  - Unit tests for manifest/workspace-file loading, workspace resolution
    precedence, and workspace chain cycle handling.
  - Integration tests covering workspace-root ordering and runtime
    provenance/meta behavior.
origin:
  authority_refs:
    - docs/cnos-spec.md
    - docs/cnos-prompt-pack.md
  derived_refs:
    - docs/cnos-workspace.md
---
Rebase CNOS core onto the workspace-first model from the superseding spec before export and CLI work. This task owns workspace manifest parsing, .cnos-workspace.yml loading, workspace selection/global-root precedence, workspace chain expansion, multi-root loader context, workspace-aware provenance/meta, and filesystem/dotenv loader path rewiring.