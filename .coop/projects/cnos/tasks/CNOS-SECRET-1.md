---
id: CNOS-SECRET-1
short_id: 9cccf695da2f
title: Runtime singleton and createCnos authenticated secret cache wiring
type: feature
status: todo
created: 2026-04-08
updated: 2026-04-08
aliases: []
priority: p0
track: v1
depends_on:
  - CORE-SECRET-1
  - CORE-AUTH-1
delivery: v1-4
acceptance:
  - createCnos() resolves secret refs through the authenticated provider cache
    in eager mode by default, with lazy mode only where supported by the design.
  - cnos('secret.*'), read, require, and secret() resolve through the secret
    cache without direct vault calls after startup.
  - cnos run --auth injects only the minimum authenticated graph payload and
    avoids decrypted secrets in __CNOS_GRAPH__ by default.
tests_required:
  - Runtime tests cover eager batch resolution, lazy mode if present, singleton
    reads, and run/auth bootstrap behavior.
  - Security tests verify decrypted secrets do not appear in browser/runtime
    public payloads or unauthenticated graph injection.
origin:
  authority_refs:
    - docs/cnos-secret-security-design.md
    - docs/cnos-changeset-1.2.md
---
