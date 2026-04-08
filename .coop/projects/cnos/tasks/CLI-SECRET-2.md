---
id: CLI-SECRET-2
short_id: 37c9e69c19be
title: Doctor, audit, and security diagnostics for secret hardening
type: feature
status: todo
created: 2026-04-08
updated: 2026-04-08
aliases: []
priority: p1
track: v1
depends_on:
  - CLI-SECRET-1
  - CNOS-SECRET-1
delivery: v1-3
acceptance:
  - doctor detects legacy vault format, tracked plaintext secret material,
    invalid vault config, missing keychain backend, and unauthenticated required
    vaults.
  - Audit logging records secret access operations without plaintext values.
  - Human help and help-ai reflect threat-safe flows, masking defaults, and
    auth/session guidance.
tests_required:
  - CLI tests cover doctor diagnostics, audit log shape, and concise failure
    messaging for secret/auth errors.
  - Docs/help tests cover secret-safe command descriptions and examples.
origin:
  authority_refs:
    - docs/cnos-secret-security-design.md
    - docs/cnos-how-to.md
---
