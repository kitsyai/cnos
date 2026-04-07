---
id: CLI-VAULT-1
short_id: 0ae16d87bd41
title: Vault CLI refinement and provider model
type: feature
status: todo
created: 2026-04-07
updated: 2026-04-07
aliases: []
priority: p2
track: v1
delivery: v1-2
acceptance:
  - cnos vault create|list|remove manages manifest-defined vaults with
    provider-aware passphrase policy.
  - Secret flows support cnos secret set|get|list --vault with local and
    github-secrets providers.
  - GitHub-style env-backed vault provider works for CI without passphrase
    requirements.
tests_required:
  - CLI tests cover vault CRUD plus secret set/get/list across provider modes.
  - Provider tests cover github-secrets reads from process.env and manifest
    wiring.
origin:
  authority_refs:
    - docs/cnos-changeset-1.2.md
    - docs/daily-use-cases.md
  derived_refs: []
---
