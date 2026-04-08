---
id: CORE-AUTH-1
short_id: 745a16add817
title: Vault auth sessions and cross-platform keychain adapters
type: feature
status: todo
created: 2026-04-08
updated: 2026-04-08
aliases: []
priority: p0
track: v1
depends_on:
  - CORE-SECRET-1
  - CORE-SECRET-2
delivery: v1-3
acceptance:
  - Vault auth chain resolves from vault-specific env, global env, OS keychain,
    and secure prompt in the design order.
  - Auth sessions store only derived vault keys in session scope and support
    local and github-secrets providers.
  - Windows Credential Manager, macOS Keychain, and Linux Secret Service
    adapters are implemented with clear unsupported-backend failures.
tests_required:
  - Core tests cover auth precedence, session lifecycle, keychain adapter
    selection, and platform backend failure handling.
  - Integration tests cover authenticated batch resolution across local and
    github-secrets vaults without CLI passphrase args.
origin:
  authority_refs:
    - docs/cnos-secret-security-design.md
---
