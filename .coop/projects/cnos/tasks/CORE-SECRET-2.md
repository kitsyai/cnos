---
id: CORE-SECRET-2
short_id: 6f2e6f3f8b16
title: Secure local vault storage format and crypto hard break
type: feature
status: todo
created: 2026-04-08
updated: 2026-04-08
aliases: []
priority: p0
track: v1
depends_on:
  - CORE-SECRET-1
delivery: v1-3
acceptance:
  - Local vault storage uses the new meta.yml plus keystore.enc format under
    ~/.cnos/secrets/vaults/<vault>.
  - Local encryption uses AES-256-GCM with PBKDF2-SHA512 and the
    design-specified iteration and metadata scheme.
  - Old per-secret JSON vault storage is rejected with a precise
    migration/remediation error.
tests_required:
  - Core tests cover crypto round-trip, tamper detection, multi-secret keystore
    operations, and legacy-format rejection.
  - CLI or integration tests verify new vaults are created only in the new
    format.
origin:
  authority_refs:
    - docs/cnos-secret-security-design.md
---
