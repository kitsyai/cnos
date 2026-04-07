---
id: CNOS-RUNTIME-1
short_id: b00ff7f66f2f
title: Singleton runtime and enhanced cnos run
type: feature
status: done
created: 2026-04-07
updated: 2026-04-07
aliases: []
priority: p2
track: v1
depends_on:
  - CORE-PROMOTE-1
  - CLI-EXPORT-1
delivery: v1-2
acceptance:
  - "@kitsy/cnos/runtime provides singleton access with cnos(key), read,
    require, readOr, value, secret, meta, and ready()."
  - cnos run supports --set overrides and --public/framework injection modes
    while bootstrapping child processes with __CNOS_GRAPH__.
  - Daily backend and deployment flows work with cnos run and singleton runtime
    reads.
tests_required:
  - Runtime tests cover synchronous bootstrap from __CNOS_GRAPH__ and standalone
    ready() behavior.
  - CLI tests cover cnos run with profile, --set overrides, and public-only
    injection.
origin:
  authority_refs:
    - docs/cnos-changeset-1.2.md
    - docs/daily-use-cases.md
---
