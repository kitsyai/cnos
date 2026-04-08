---
id: CLI-SECRET-1
short_id: 50fbac36205d
title: CLI secret CRUD masking and reveal controls
type: feature
status: todo
created: 2026-04-08
updated: 2026-04-08
aliases: []
priority: p0
track: v1
depends_on:
  - CORE-AUTH-1
  - CLI-AUTH-1
delivery: v1-4
acceptance:
  - cnos secret set|get|list|remove and verb-first aliases run through the new
    provider and auth path.
  - Secret output is masked by default in get, inspect, list, errors, and
    export-on-TTY, with explicit reveal only where allowed.
  - Interactive secret input and stdin flows are supported without leaking
    plaintext to history by default.
tests_required:
  - CLI tests cover masked-by-default output, reveal gating, stdin and
    interactive input, and provider-aware list/remove behavior.
  - Integration tests verify secret reads and inspect remain masked unless
    reveal is explicitly requested.
origin:
  authority_refs:
    - docs/cnos-secret-security-design.md
    - docs/daily-use-cases.md
---
