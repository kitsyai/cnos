---
id: CORE-SECRET-1
short_id: 661062bcba2d
title: Core secret provider abstraction, cache, and batch resolution
type: feature
status: done
created: 2026-04-08
updated: 2026-04-08
aliases: []
priority: p0
track: v1
delivery: v1-3
acceptance:
  - Provider abstraction exists for local and github-secrets vaults with
    authenticate, isAuthenticated, batchGet, get, set, delete, list, and
    healthCheck semantics.
  - Secret cache and startup batch-resolution path replace direct loader-time
    local secret reads for runtime resolution.
  - Legacy local vault format is detected early with a hard-fail error carrying
    remediation guidance.
tests_required:
  - Core tests cover provider contract behavior, batch grouping, cache
    lifecycle, and legacy-format detection.
  - Integration tests cover createCnos() scanning ref objects and grouping by
    vault before runtime reads.
origin:
  authority_refs:
    - docs/cnos-secret-security-design.md
    - docs/daily-use-cases.md
---
