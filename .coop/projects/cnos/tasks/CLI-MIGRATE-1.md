---
id: CLI-MIGRATE-1
short_id: 8160a29175b1
title: Env usage migration assistant
type: feature
status: done
created: 2026-04-08
updated: 2026-04-08
aliases: []
priority: p2
track: v1
delivery: v1-3
acceptance:
  - cnos migrate scans JS/TS source for process.env and import.meta.env usage
    and proposes logical CNOS mappings, secret detection, and public promotion
    candidates.
  - Dry-run prints findings without writing, and apply mode updates manifest env
    mappings/public promote entries deterministically.
  - Optional source rewrite creates backups and rewrites directly supported env
    access patterns to cnos.value/secret usage.
tests_required:
  - Unit tests cover env usage scanning, logical key proposal, secret/public
    detection, and manifest patch generation.
  - CLI/integration tests cover dry-run output, apply mode manifest updates, and
    backup-producing source rewrites.
origin:
  authority_refs:
    - docs/cnos-spec.md
    - docs/cnos-changeset-1.3.md
  derived_refs:
    - docs/daily-use-cases.md
    - docs/cnos-v1-complete-test-suite.md
---
