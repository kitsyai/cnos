---
id: CLI-AUTH-1
short_id: cf910fafbb67
title: CLI vault auth and threat-safe auth UX
type: feature
status: done
created: 2026-04-08
updated: 2026-04-08
aliases: []
priority: p0
track: v1
depends_on:
  - CORE-AUTH-1
delivery: v1-3
acceptance:
  - cnos vault auth and cnos vault logout manage vault auth sessions with
    prompt, env, and keychain flows.
  - CLI rejects --passphrase across vault and secret commands with concise
    actionable guidance.
  - Auth-aware secret and run flows reuse active sessions without repeated
    prompts.
tests_required:
  - CLI tests cover vault auth, logout, passphrase rejection, and run/auth
    prompting behavior.
  - Help and help-ai coverage reflects the auth-session model and removal of
    passphrase-arg UX.
origin:
  authority_refs:
    - docs/cnos-secret-security-design.md
    - docs/cnos-spec.md
---
