# Security Design Reference

Full spec: see `cnos-secret-security-design.md` in project docs.

## Storage Model

- Repo YAML stores only refs: `{ provider: "local", vault: "local-dev", ref: "db.password" }`.
- Actual secret material lives outside the repo in `~/.cnos/secrets/vaults/<vault-id>/keystore.enc`.
- Local vault encryption: AES-256-GCM, PBKDF2-SHA512, 600K iterations, 32-byte random salt per vault.

## Authentication

Auth resolution chain (per vault, first non-empty wins):
1. `env:CNOS_SECRET_PASSPHRASE_<VAULT_ID>` (vault-specific env var)
2. `env:CNOS_SECRET_PASSPHRASE` (global fallback)
3. `keychain:cnos/<vault-id>` (OS keychain)
4. `prompt` (interactive, TTY only — skipped in non-TTY)

`cnos vault auth <id>` stores the derived key (not passphrase) in `__CNOS_VAULT_KEY_<ID>__` env var for the shell session.

Passphrases as CLI args: deprecated warning by default, hard rejected when `CNOS_STRICT_AUTH=true` or `NODE_ENV=production`.

## Batch Resolution

All secret refs batch-resolved at startup via `batchGet()`:
- Local vault: one file read + one decrypt = all secrets.
- Remote providers: batch API calls.
- Individual `cnos.secret()` reads hit in-memory cache, zero I/O.

Hydration policies: `eager` (startup, default), `lazy` (first read), `refreshing` (startup + TTL refresh).

## Projection Rules

- `__CNOS_PROJECTION__` env var: secret refs only, never plaintext.
- `cnos run --auth`: encrypts secrets with random session key, passes `__CNOS_SESSION_KEY__` to child.
- `.cnos-server.json` file: secret refs only, safe to commit or bake into Docker image.
- Browser data (`__CNOS_BROWSER_DATA__`): never contains `secret.*` in any form.

## CLI Output Rules

- TTY stdout: secrets masked as `****`. `--reveal` to show.
- Piped (non-TTY) stdout: real values (consumer is the intended recipient).
- File output (`--to`): real values (file is the deployment artifact).
- `cnos list`: never shows secret values, even with `--reveal`.
- `cnos inspect secret.x`: shows `****` unless `--reveal`.

## Audit

Every vault access logged to `~/.cnos/audit/access.log` (JSON lines).
Logged: timestamp, action, vault, ref, caller, workspace, profile.
Never logged: secret values, passphrases, tokens.
