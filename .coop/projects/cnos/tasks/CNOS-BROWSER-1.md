---
id: CNOS-BROWSER-1
short_id: 55a40278371d
title: Browser runtime and build-time public embedding
type: feature
status: done
created: 2026-04-07
updated: 2026-04-07
aliases: []
priority: p2
track: v1
depends_on:
  - CORE-PROMOTE-1
  - CNOS-RUNTIME-1
delivery: v1-2
acceptance:
  - "@kitsy/cnos/browser reads embedded promoted public data and blocks secret.*
    access."
  - "@kitsy/cnos/build exposes resolveBrowserData() and returns only public.*
    graph entries."
  - Vite and Next integrations embed browser data while preserving
    framework-native public env output.
tests_required:
  - Browser/runtime tests cover public reads, missing-key behavior, and secret
    access failures.
  - Vite and Next tests cover __CNOS_BROWSER_DATA__ embedding alongside existing
    framework env behavior.
origin:
  authority_refs:
    - docs/cnos-changeset-1.2.md
    - docs/daily-use-cases.md
---
