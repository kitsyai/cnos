---
id: CNOS-SECRET-2
short_id: 7de0f717959a
title: Docs, examples, and daily-use-case validation for secure secret model
type: feature
status: todo
created: 2026-04-08
updated: 2026-04-08
aliases: []
priority: p1
track: v1
depends_on:
  - CLI-SECRET-2
delivery: v1-3
acceptance:
  - Spec, how-to, examples, and prompt/help docs reflect the 1.4 auth-session
    and secret-security model.
  - Daily-use-case scenarios are validated against the implemented secret flows
    for local dev, CI/CD, server runtime, and public/browser safety.
  - Legacy passphrase-arg examples are removed or replaced with auth/session
    workflows.
tests_required:
  - Examples and integration tests cover the documented daily secret workflows
    end to end.
  - Doc references are aligned to the implemented 1.4 behavior with no stale
    passphrase examples.
origin:
  authority_refs:
    - docs/cnos-secret-security-design.md
    - docs/daily-use-cases.md
    - docs/cnos-how-to.md
---
