---
id: CLI-EXPORT-1
short_id: 2cde1b3da54c
title: Env file export bridge and profile-targeted export
type: feature
status: done
created: 2026-04-07
updated: 2026-04-07
aliases: []
priority: p2
track: v1
depends_on:
  - CORE-PROMOTE-1
delivery: v1-2
acceptance:
  - cnos export env supports --to for explicit file writes without changing
    stdout behavior when omitted.
  - Profile-targeted public and private env exports write pure KEY=VALUE output
    for .env.local/.env.stage/.env.prod flows.
  - list public supports framework-prefixed inspection for the emitted public
    env surface.
tests_required:
  - CLI tests cover export env --to for base, profile, vite, and next output
    paths.
  - Integration tests verify file contents stay deterministic KEY=VALUE with no
    ambient env leakage.
origin:
  authority_refs:
    - docs/cnos-changeset-1.2.md
    - docs/daily-use-cases.md
---
