# Vault Admin Surface Plan

Status: draft for post-1.11.2 implementation.

## Problem

`cnos secret set` authors project configuration. For non-local vaults, it must write only repo-safe reference metadata. Users also need a separate, explicit way to create, update, read, list, and delete secret material in backing vault systems such as Google Secret Manager, AWS Secrets Manager, HashiCorp Vault, Azure Key Vault, environment-backed deployment systems, and CNOS local vaults.

## Direction

Use named vaults as the primary project configuration surface:

```bash
cnos secret set youtube.apiKey --vault media-gcp-prod --workspace api --profile prod-gcp
```

For non-local vaults, the command writes metadata only:

```yaml
provider: gcp-secret-manager
ref: youtube.apiKey
vault: media-gcp-prod
```

Actual secret material is managed through a separate vault admin surface:

```bash
cnos vault put media-gcp-prod youtube.apiKey --stdin
cnos vault get media-gcp-prod youtube.apiKey --reveal
cnos vault list media-gcp-prod
cnos vault remove media-gcp-prod youtube.apiKey
```

## Provider Overrides

`--provider <name>` can be an escape hatch for ad hoc reference authoring and future vault admin operations, but named vaults should remain the recommended production surface because they carry shared auth, mapping, fallback, version, location, and project/account metadata.

Per-secret provider config can be supported later, but only with a projection-safe shape. Do not allow arbitrary `auth.config` or raw provider config under a secret reference unless it passes the same allowlist/sanitization boundary used for projected vault metadata.

## Security Rules

- `secret set` must never prompt for or store plaintext material for non-local providers by default.
- Remote `vault put` must be explicit and must never accept secret material as an ordinary CLI argument by default; use prompt or `--stdin`.
- Remote provider packages must be compiled/installed capabilities. CNOS must not dynamically load provider packages from config.
- CLI output must never reveal secret material unless `--reveal` is explicitly used for read operations.
- Projections must serialize refs and sanitized metadata only, never plaintext credentials or secret values.
- Write-capable provider support must be declared by provider capability and tested through the shared vault testkit.

## Global Vault CLI

`cnos vault list` should become useful outside a CNOS workspace by listing local CNOS vault stores from `~/.cnos/secrets` and, when inside a project, merging manifest-defined vaults. Project-scoped vault definitions still require `.cnosrc.yml`; global local-vault inspection should not.

Remote `vault get|put|list|remove --provider <name>` outside a project can be supported only when all required provider config is supplied via flags/env/config file and the provider package is available at runtime.
