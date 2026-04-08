# CNOS — Secret Security Design (Revised)

**Purpose:** Specifies how CNOS securely handles secrets: storage, authentication, runtime access, CLI access, caching, and audit. Implementation-ready.

**Compatibility:** Preserves the existing `ref` field name and `{ provider, vault, ref }` object shape. No breaking changes to the current storage model.

---

## 1. Threat Model

| ID | Threat | Severity |
|----|--------|----------|
| T1 | Plaintext secrets committed to repo | Critical |
| T2 | Plaintext passphrase in manifest or committed files | Critical |
| T3 | `secret.*` leaking to browser/public surfaces | Critical |
| T4 | Secret values in CLI output, logs, or error messages | High |
| T5 | Passphrase visible in `ps aux` (CLI arg) | High |
| T6 | Unencrypted vault at rest | High |
| T7 | Per-read vault calls causing latency | High |
| T8 | Decrypted secrets in `__CNOS_GRAPH__` env var | High |
| T9 | Unauthorized vault access (no auth required) | Medium |
| T10 | No audit trail | Medium |

---

## 2. Security Invariants

1. **No plaintext secrets in the repo.** `.cnos/secrets/` YAML contains only ref objects. Actual material lives outside the repo.
2. **No plaintext passphrases in the repo.** Passphrases come from env vars, OS keychain, or interactive prompt — never from committed files.
3. **`secret.*` never reaches public/browser surfaces.** Enforced at namespace level.
4. **Secrets masked in CLI output** by default. `--reveal` required for actual values.
5. **Secrets batch-resolved at startup**, cached in memory. Individual reads hit cache, not the vault.
6. **Authentication required before any secret access.** Method varies by provider.
7. **No passphrase as CLI argument** by default. Interactive prompt (like `sudo`) or env var only.
8. **Decrypted secrets not in `__CNOS_GRAPH__`** by default.

---

## 3. Storage Model

### 3.1 What lives in the repo (unchanged from current)

The existing storage model is preserved. Secrets land in `.cnos/secrets/` (non-workspace mode) or `.cnos/workspaces/<id>/secrets/` (workspace mode).

```yaml
# .cnos/secrets/local/app.yml (non-workspace mode)
# or .cnos/workspaces/api/secrets/local/app.yml (workspace mode)
db:
  password:
    provider: local
    vault: local-dev
    ref: db.password
  connection_string:
    provider: local
    vault: local-dev
    ref: db.connection_string

api:
  key:
    provider: github-secrets
    vault: github-ci
    ref: API_KEY
```

**Decision: keep `ref`, not `$ref`.** The field name `ref` is already shipped. The value remains a string identifying the secret within the vault. The surrounding object (`{ provider, vault, ref }`) gives CNOS everything it needs to resolve. No URI syntax needed.

### 3.2 What lives outside the repo (local provider)

```
~/.cnos/secrets/
  vaults/
    local-dev/
      meta.yml          # vault metadata (algorithm, salt, iterations, created)
      keystore.enc      # encrypted key-value store
```

### 3.3 What lives nowhere (remote providers)

GitHub Actions, AWS Secrets Manager, HashiCorp Vault — secrets fetched at resolution time. No local storage.

---

## 4. Authentication Model

### 4.1 How authentication works

Every vault declares an `auth` block in the manifest. CNOS resolves credentials by walking the `from` list in order until one succeeds.

```yaml
vaults:
  local-dev:
    provider: local
    auth:
      passphrase:
        from:
          - env:CNOS_SECRET_PASSPHRASE_LOCAL_DEV
          - env:CNOS_SECRET_PASSPHRASE
          - keychain:cnos/local-dev
          - prompt
```

Resolution order for each source:

1. `env:<VAR>` — read `process.env[VAR]`. If present and non-empty, use it.
2. `keychain:<entry>` — read from OS keychain. If available and entry exists, use it.
3. `prompt` — if `process.stdout.isTTY`, prompt interactively (hidden input, like `sudo`). If not TTY, skip (do not hang).

First non-empty result wins. If all sources exhausted, throw `CnosAuthenticationError` listing what was tried.

### 4.2 Default auth when no `auth` block

If a local vault has no explicit `auth` block, CNOS uses this default chain:

```
env:CNOS_SECRET_PASSPHRASE_<VAULT_ID_UPPERCASED> → env:CNOS_SECRET_PASSPHRASE → prompt
```

This preserves backward compatibility. Existing setups that use `CNOS_SECRET_PASSPHRASE` continue to work.

### 4.3 No passphrase as CLI argument

**Rule:** CNOS does not accept `--passphrase <value>` as a CLI argument by default. Passphrases are never passed as process arguments because they are visible in `ps aux`.

How users provide passphrases:

```bash
# Option 1: Environment variable (recommended for CI/CD and scripts)
export CNOS_SECRET_PASSPHRASE_LOCAL_DEV=dev-pass
cnos secret get db.password --vault local-dev

# Option 2: Interactive prompt (recommended for local dev)
cnos secret get db.password --vault local-dev
# Enter passphrase for vault "local-dev": [hidden input, like sudo]

# Option 3: OS keychain (recommended for frequent local use)
cnos vault auth local-dev --store-keychain
# Enter passphrase for vault "local-dev": [hidden input]
# Stored in system keychain.
# Subsequent commands use keychain automatically.
```

### 4.4 CLI session authentication

```bash
# Authenticate once for the shell session
cnos vault auth local-dev
# Enter passphrase for vault "local-dev": [hidden input]
# ✓ Authenticated. Session active until shell exits or cnos vault logout.

# Subsequent commands don't re-prompt
cnos secret get db.password --vault local-dev     # no prompt
cnos secret list --vault local-dev                 # no prompt
cnos run -- node server.js                         # secrets available

# End session
cnos vault logout local-dev
```

**Implementation:** `cnos vault auth` derives the encryption key from the passphrase, then stores the **derived key** (not the passphrase) in an env var `__CNOS_VAULT_KEY_<VAULT_ID>__`. Commands spawned in the same shell inherit it. The derived key cannot be reversed to the passphrase.

### 4.5 Provider-specific auth

```yaml
vaults:
  github-ci:
    provider: github-secrets
    auth:
      method: environment        # reads secrets directly from process.env
    mapping:
      DB_PASSWORD: db.password   # process.env.DB_PASSWORD → secret.db.password
      API_KEY: api.key

  aws-prod:
    provider: aws-secrets-manager
    auth:
      method: iam                # ambient IAM role, no credentials needed
      config:
        region: us-east-1

  hashi-staging:
    provider: hashicorp-vault
    auth:
      method: token
      token:
        from:
          - env:VAULT_TOKEN
          - file:~/.vault-token
      config:
        address: https://vault.internal:8200
        path: secret/data/myapp
```

---

## 5. Runtime Secret Resolution — Batch Pre-Loading

### 5.1 The problem with lazy per-read resolution

If every `cnos.secret("db.password")` call triggered a vault decryption or network fetch, production performance would be unacceptable — especially for remote providers like HashiCorp Vault or AWS Secrets Manager where each call involves a network round-trip.

### 5.2 Solution: batch resolve at startup, read from cache

Secrets are resolved in two phases:

**Phase A — Batch resolve (during `createCnos()` or `cnos.ready()`):**

1. Scan the resolved graph for all `secret.*` entries that contain ref objects.
2. Group refs by vault ID.
3. For each vault:
   a. Authenticate using the auth resolution chain (§4.1).
   b. Batch-fetch all refs in a single operation.
   c. Store decrypted values in an in-memory `SecretCache`.
4. After this phase, all secrets are in memory. No further vault calls needed.

**Phase B — Read from cache (during `cnos.secret(...)`):**

1. Look up key in `SecretCache`.
2. Return value. Zero latency, zero I/O.

### 5.3 What this means in practice

```ts
// At startup — one vault round-trip per vault, all secrets pre-loaded
const cnos = await createCnos();
// Authentication and decryption happened during createCnos().
// If auth failed, createCnos() threw CnosAuthenticationError.

// At runtime — cache reads, zero vault calls
const pass = cnos.secret("db.password");     // from cache, instant
const conn = cnos.secret("db.conn_string");  // from cache, instant
```

For remote providers, the batch operation maps to:
- **AWS Secrets Manager:** `BatchGetSecretValue` API call (up to 20 per call)
- **HashiCorp Vault:** `GET /v1/secret/data/<path>` (one call if secrets share a path)
- **GitHub Actions:** `process.env` scan (instant, no network)
- **Local vault:** Single keystore decryption (one file read, one decrypt)

### 5.4 SecretCache

```ts
class SecretCache {
  private cache = new Map<string, string>();
  private authenticated = new Set<string>();  // vault IDs that authenticated

  /**
   * Called during batch resolve. Populates cache for all refs from a vault.
   */
  load(vaultId: string, secrets: Map<string, string>): void {
    this.authenticated.add(vaultId);
    for (const [ref, value] of secrets) {
      this.cache.set(`${vaultId}:${ref}`, value);
    }
  }

  /**
   * Called during cnos.secret() reads.
   */
  get(vaultId: string, ref: string): string | undefined {
    if (!this.authenticated.has(vaultId)) {
      throw new CnosAuthenticationError(`Vault "${vaultId}" was not authenticated during resolution.`);
    }
    return this.cache.get(`${vaultId}:${ref}`);
  }

  /**
   * Clear all cached secrets. Used for testing and explicit cache invalidation.
   */
  clear(): void {
    this.cache.clear();
    this.authenticated.clear();
  }
}
```

Properties:
- Per-runtime instance (not global/static).
- Not persisted to disk.
- Cleared when runtime is garbage collected.
- Explicitly clearable via `cnos.clearSecretCache()`.
- Decrypted values exist ONLY in this cache and the return value of `cnos.secret()`.

### 5.5 Optional lazy mode

For development scenarios where vault auth might not be available at startup (e.g., optional secrets), a lazy mode is available:

```ts
const cnos = await createCnos({ secretResolution: "lazy" });
// No vault auth at startup. Secrets resolved on first read.
// Useful for dev when some vaults might not be configured.
```

Default is `"eager"` (batch at startup). `"lazy"` defers to first read. In lazy mode, the first `cnos.secret(...)` call for each vault triggers auth + fetch for that vault's refs.

---

## 6. `cnos run` — Authenticated Mode

### 6.1 Two modes

```bash
# Unauthenticated (default): child process resolves secrets itself
cnos run -- node server.js
# Child gets __CNOS_GRAPH__ WITHOUT secrets.
# Child's cnos.ready() authenticates and batch-resolves secrets.

# Authenticated: secrets pre-resolved, passed to child
cnos run --auth -- node server.js
# CNOS authenticates all vaults, resolves all secrets.
# Child gets __CNOS_GRAPH__ WITH secrets (encrypted with a session key).
# Child's cnos.ready() decrypts from graph, no vault access needed.
```

### 6.2 How `--auth` works

1. `cnos run --auth` resolves the full graph including secrets.
2. Generates a random 256-bit session key.
3. Encrypts the secret portion of the graph with the session key (AES-256-GCM).
4. Injects into child env:
   - `__CNOS_GRAPH__` — full graph with secrets as encrypted blobs.
   - `__CNOS_SESSION_KEY__` — the session key (hex-encoded).
5. Child's singleton runtime detects `__CNOS_SESSION_KEY__`, decrypts secrets from graph.
6. No vault access needed in the child.

### 6.3 Why this is safe

- The session key is random, single-use, and ephemeral.
- It exists only in `process.env` of the child, not in any file.
- When the child exits, the key is gone.
- The encrypted secret blobs in `__CNOS_GRAPH__` are useless without the session key.
- An attacker who can read `process.env` can also read `process.env.DB_PASSWORD` in a traditional setup — the threat model is equivalent.

### 6.4 Generalizing: authenticated subprocess

This pattern generalizes beyond `cnos run`. Any CNOS subprocess can be run in authenticated mode:

```bash
# cnos run with auth
cnos run --auth -- node server.js

# cnos watch with auth (restarts inherit auth)
cnos watch --auth -- node server.js

# Future: cnos as a sidecar/daemon holds auth state
cnos daemon --auth
```

The `--auth` flag means: "resolve secrets now, pass them to the child securely."

### 6.5 When `cnos run` prompts for auth

If `--auth` is used and a vault requires a passphrase, `cnos run` prompts interactively before spawning the child:

```bash
cnos run --auth -- node server.js
# Enter passphrase for vault "local-dev": [hidden input]
# ✓ Authenticated. Starting node server.js...
```

If already authenticated via `cnos vault auth` session or env var, no prompt.

---

## 7. CLI Secret Access

### 7.1 Reading

```bash
# Default: masked
cnos secret get db.password --vault local-dev
# Enter passphrase for vault "local-dev": [hidden input]  ← only if not already authenticated
# ****

# Reveal
cnos secret get db.password --vault local-dev --reveal
# s3cr3t

# JSON
cnos secret get db.password --vault local-dev --json --reveal
# { "key": "secret.db.password", "value": "s3cr3t", "vault": "local-dev" }
```

### 7.2 Setting

```bash
# Interactive: value not echoed (like sudo password input)
cnos secret set db.password --vault local-dev
# Enter passphrase for vault "local-dev": [hidden]  ← if needed
# Enter secret value: [hidden input]
# ✓ Secret "db.password" stored in vault "local-dev".

# Piped (for scripts)
echo "s3cr3t" | cnos secret set db.password --vault local-dev --stdin

# Direct value (backward compat, deprecated)
cnos secret set db.password s3cr3t --vault local-dev
# Warning: Secret value visible in shell history. Use interactive input or --stdin.
```

### 7.3 Listing

```bash
cnos secret list --vault local-dev
# secret.db.password           (vault: local-dev, provider: local)
# secret.db.connection_string  (vault: local-dev, provider: local)
```

Values NEVER shown in list, even with `--reveal`.

### 7.4 Inspect

```bash
cnos inspect secret.db.password
# Key:       secret.db.password
# Value:     ****
# Namespace: secret
# Vault:     local-dev
# Provider:  local
# Ref:       db.password
# Auth:      authenticated

cnos inspect secret.db.password --reveal
# Value:     s3cr3t
```

### 7.5 Export

```bash
# Stdout (TTY): masked
cnos export env
# PORT=3000
# DB_PASSWORD=****

# Stdout (piped/non-TTY): real values
cnos export env | cat
# PORT=3000
# DB_PASSWORD=s3cr3t

# File output: always real values (file is the deployment artifact)
cnos export env --to .env.prod
# File contains: DB_PASSWORD=s3cr3t

# Explicit reveal on TTY
cnos export env --reveal
# DB_PASSWORD=s3cr3t
```

Detection: `process.stdout.isTTY` determines masking behavior. Piped output includes real values because the pipe consumer is the intended recipient.

---

## 8. Local Vault — Cryptography

### 8.1 Scheme

| Parameter | Value |
|-----------|-------|
| Algorithm | AES-256-GCM |
| Key derivation | PBKDF2-SHA512 |
| Iterations | 600,000 (OWASP 2023) |
| Salt | 32 bytes, random, per vault |
| IV | 12 bytes, random, per encrypt |
| Auth tag | 16 bytes (GCM default) |

### 8.2 Keystore format

```
[4 bytes: version uint32, currently 1]
[12 bytes: IV]
[16 bytes: GCM auth tag]
[remaining: AES-256-GCM ciphertext]
```

Decrypted payload:

```json
{
  "secrets": {
    "db.password": "s3cr3t",
    "db.connection_string": "postgres://..."
  },
  "metadata": {
    "db.password": { "createdAt": "...", "updatedAt": "..." }
  }
}
```

### 8.3 Vault metadata (unencrypted)

```yaml
# ~/.cnos/secrets/vaults/local-dev/meta.yml
version: 1
algorithm: aes-256-gcm
kdf: pbkdf2-sha512
iterations: 600000
salt: <base64>
createdAt: "2025-01-15T10:00:00Z"
secretCount: 2
```

Contains no secret material. Salt alone is useless without passphrase.

### 8.4 Batch operation for local vault

The local vault decrypts the entire keystore in one operation (single file read + decrypt). This is inherently batched — all secrets are available after one decryption.

---

## 9. Provider Contract

### 9.1 Base interface

```ts
interface SecretVaultProvider {
  readonly id: string;
  readonly providerType: string;

  /**
   * Authenticate to the vault.
   * Throws CnosAuthenticationError on failure.
   */
  authenticate(authConfig: VaultAuthConfig): Promise<void>;

  /**
   * Whether currently authenticated.
   */
  isAuthenticated(): boolean;

  /**
   * Batch-fetch all secrets for the given refs.
   * Called once during resolution, not per-read.
   */
  batchGet(refs: string[]): Promise<Map<string, string>>;

  /**
   * Get a single secret. Used by CLI commands, not runtime.
   */
  get(ref: string): Promise<string | undefined>;

  /**
   * Set a secret.
   */
  set(ref: string, value: string): Promise<void>;

  /**
   * Delete a secret.
   */
  delete(ref: string): Promise<void>;

  /**
   * List all secret refs.
   */
  list(): Promise<string[]>;
}

interface RemoteSecretVaultProvider extends SecretVaultProvider {
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}
```

Key addition: `batchGet()`. This is the primary method used by the runtime. It takes all refs at once and returns all values at once. For local vaults this is one decrypt. For remote vaults this maps to batch API calls.

### 9.2 Auth config

```ts
interface VaultAuthConfig {
  passphrase?: string;         // resolved from auth chain (never from CLI arg)
  token?: string;              // for token-based providers
  derivedKey?: Buffer;         // pre-derived key from cnos vault auth session
  method: "passphrase" | "environment" | "token" | "iam" | "keychain";
  config?: Record<string, unknown>;
}
```

---

## 10. Auth Resolution Flow

```
resolveVaultAuth(vaultId, vaultManifestConfig):

  1. Check for pre-existing session key:
     if process.env.__CNOS_VAULT_KEY_<ID>__ exists:
       return { derivedKey: Buffer.from(envValue, "hex") }

  2. Walk auth.passphrase.from (or auth.token.from) list:
     for each source in list:
       if source starts with "env:":
         value = process.env[varName]
         if value: return { passphrase: value }
       if source starts with "keychain:":
         value = readKeychain(entry)
         if value: return { derivedKey: value }  // keychain stores derived key
       if source == "prompt":
         if process.stdout.isTTY:
           value = promptHidden("Enter passphrase for vault \"${vaultId}\":")
           return { passphrase: value }
         else:
           continue  // skip prompt in non-TTY (don't hang)
       if source starts with "file:":
         value = readFile(path)
         if value: return { token: value }

  3. If all sources exhausted:
     throw CnosAuthenticationError(
       "Cannot authenticate to vault '${vaultId}'.\n" +
       "Tried: ${sources.join(', ')}.\n" +
       "Set ${envVarName} or run: cnos vault auth ${vaultId}"
     )
```

---

## 11. Audit Trail

### 11.1 Access log

```json
{"ts":"...","action":"batch_read","vault":"local-dev","refs":["db.password","db.conn"],"caller":"runtime","workspace":"api","profile":"local"}
{"ts":"...","action":"write","vault":"local-dev","ref":"db.password","caller":"cli"}
{"ts":"...","action":"auth_success","vault":"local-dev","method":"env"}
{"ts":"...","action":"auth_failure","vault":"local-dev","method":"prompt","reason":"wrong passphrase"}
```

Written to `~/.cnos/audit/access.log` (local) or stderr (CI/CD). Configurable via `CNOS_AUDIT_FILE`.

### 11.2 What is NOT logged

Secret values, passphrases, tokens, derived keys.

---

## 12. `cnos doctor` — Security Checks

```
Security:
  ✓ No plaintext secret values in repo YAML (only ref objects)
  ✓ No passphrase fields in cnos.yml
  ✓ Vault keystores encrypted at rest
  ✓ secrets/ directory in .gitignore
  ✓ No secret.* in public.promote
  ✓ No secret.* in envMapping.explicit
  ✓ All configured vaults exist (auth not tested)

Warnings:
  ⚠ Vault "local-dev" using generic env var (consider vault-specific)
  ⚠ No OS keychain configured for vault "local-dev"
  ⚠ --passphrase CLI arg used in recent commands (deprecated)
```

---

## 13. Manifest — Complete Vault + Auth Example

```yaml
vaults:
  local-dev:
    provider: local
    auth:
      passphrase:
        from:
          - env:CNOS_SECRET_PASSPHRASE_LOCAL_DEV
          - env:CNOS_SECRET_PASSPHRASE
          - keychain:cnos/local-dev
          - prompt

  github-ci:
    provider: github-secrets
    auth:
      method: environment
    mapping:
      DB_PASSWORD: db.password
      API_KEY: api.key

  aws-prod:
    provider: aws-secrets-manager
    auth:
      method: iam
      config:
        region: us-east-1
        secretPrefix: /myapp/prod/

  hashi-staging:
    provider: hashicorp-vault
    auth:
      method: token
      token:
        from:
          - env:VAULT_TOKEN
          - file:~/.vault-token
      config:
        address: https://vault.internal:8200
        path: secret/data/myapp
```

---

## 14. Module Layout

```
packages/cnos/src/
  secrets/
    types.ts                    # SecretRef, VaultAuthConfig, SecretVaultProvider
    resolveAuth.ts              # auth resolution chain walker
    secretCache.ts              # per-runtime in-memory cache
    batchResolve.ts             # batch-fetch all refs grouped by vault
    auditLog.ts                 # access logging
    mask.ts                     # value masking (****)
    providers/
      local.ts                  # AES-256-GCM encrypted vault
      github.ts                 # process.env reader with mapping
      registry.ts               # provider registry
    crypto/
      encrypt.ts                # AES-256-GCM operations
      kdf.ts                    # PBKDF2 key derivation
      sessionKey.ts             # cnos run --auth session key generation
    keychain/
      index.ts                  # OS keychain abstraction
      macos.ts
      windows.ts
      linux.ts
  orchestrator/
    runtime.ts                  # intercept secret.* reads → cache lookup
    pipeline.ts                 # batch resolve during createCnos()

packages/cli/src/
  commands/
    vault.ts                    # vault create/list/remove/auth/logout
    secret.ts                   # secret get/set/delete/list
    run.ts                      # --auth flag
```

---

## 15. Test Specifications

### Security invariants (SEC)

- [ ] SEC-1: Repo secrets YAML contains only `{ provider, vault, ref }` objects, never plaintext values.
- [ ] SEC-2: Passphrase never written to any committed file.
- [ ] SEC-3: `secret.*` never in `toPublicEnv()`.
- [ ] SEC-4: `secret.*` never in browser runtime data.
- [ ] SEC-5: CLI masks secret values by default.
- [ ] SEC-6: `--reveal` shows actual values.
- [ ] SEC-7: `cnos inspect secret.x` shows `****` without `--reveal`.
- [ ] SEC-8: `cnos export env --to .env` writes real values.
- [ ] SEC-9: `cnos export env` to TTY masks secrets.
- [ ] SEC-10: `cnos export env` piped includes real values.
- [ ] SEC-11: `__CNOS_GRAPH__` without `--auth` contains NO decrypted secrets.
- [ ] SEC-12: `cnos run --auth` includes encrypted secrets + session key.
- [ ] SEC-13: `--passphrase` arg prints deprecation warning.
- [ ] SEC-14: `--passphrase` arg rejected when `CNOS_STRICT_AUTH=true`.

### Batch resolution (BATCH)

- [ ] BATCH-1: `createCnos()` batch-resolves all secret refs at startup.
- [ ] BATCH-2: Individual `cnos.secret()` reads hit cache, not vault.
- [ ] BATCH-3: Only one vault authentication per vault during batch resolve.
- [ ] BATCH-4: Local vault: single file read + single decrypt = all secrets.
- [ ] BATCH-5: `batchGet()` called with all refs for each vault.
- [ ] BATCH-6: Auth failure during batch → `CnosAuthenticationError` before app starts.
- [ ] BATCH-7: Lazy mode (`secretResolution: "lazy"`) defers to first read.
- [ ] BATCH-8: Cache cleared by `clearSecretCache()`.
- [ ] BATCH-9: Cache is per-runtime instance, not global.
- [ ] BATCH-10: Two runtime instances have independent caches.

### Auth resolution (AUTH)

- [ ] AUTH-1: Vault-specific env var wins over global.
- [ ] AUTH-2: Keychain entry used when env var absent.
- [ ] AUTH-3: Prompt shown in TTY when env and keychain absent.
- [ ] AUTH-4: Prompt skipped in non-TTY (no hanging).
- [ ] AUTH-5: All sources exhausted → error listing what was tried.
- [ ] AUTH-6: `cnos vault auth` stores derived key in env.
- [ ] AUTH-7: Subsequent commands use stored key without prompt.
- [ ] AUTH-8: `cnos vault logout` clears stored key.
- [ ] AUTH-9: Derived key in env is hex-encoded, not the passphrase.
- [ ] AUTH-10: Wrong passphrase → `CnosAuthenticationError`.

### Local vault (LV)

- [ ] LV-1: Create vault → `keystore.enc` + `meta.yml` created.
- [ ] LV-2: `keystore.enc` is not readable as JSON (encrypted).
- [ ] LV-3: Set secret → stored in encrypted keystore.
- [ ] LV-4: Get with correct passphrase → returns value.
- [ ] LV-5: Get with wrong passphrase → `CnosAuthenticationError`.
- [ ] LV-6: Get without auth → `CnosAuthenticationError`.
- [ ] LV-7: List returns refs, not values.
- [ ] LV-8: Delete removes from keystore.
- [ ] LV-9: Persists across process restarts.
- [ ] LV-10: Two vaults with different passphrases → independent.
- [ ] LV-11: Corrupted keystore → clear error.
- [ ] LV-12: Empty keystore → no secrets, no error.
- [ ] LV-13: `batchGet()` returns all secrets in one operation.

### cnos run --auth (RUN-AUTH)

- [ ] RUN-AUTH-1: `--auth` resolves secrets before spawning child.
- [ ] RUN-AUTH-2: Child env has `__CNOS_SESSION_KEY__`.
- [ ] RUN-AUTH-3: Child singleton decrypts secrets from graph using session key.
- [ ] RUN-AUTH-4: Session key is random, different each run.
- [ ] RUN-AUTH-5: Without `--auth`, child graph has no secrets.
- [ ] RUN-AUTH-6: `--auth` prompts for passphrase if needed before spawn.
- [ ] RUN-AUTH-7: Auth failure → error before child spawns.

### GitHub secrets provider (GH)

- [ ] GH-1: Reads from `process.env` using mapping.
- [ ] GH-2: Missing env var → clear error with var name.
- [ ] GH-3: No passphrase required.
- [ ] GH-4: `batchGet()` reads all mapped vars at once.
- [ ] GH-5: List returns mapped ref names.

### Audit (AUD)

- [ ] AUD-1: `batch_read` logged with ref list.
- [ ] AUD-2: `write` logged with ref.
- [ ] AUD-3: `auth_success` logged with method.
- [ ] AUD-4: `auth_failure` logged without credentials.
- [ ] AUD-5: Secret values never in log.

### Doctor (DOC-SEC)

- [ ] DOC-SEC-1: Plaintext value in secrets YAML → warning.
- [ ] DOC-SEC-2: Passphrase field in cnos.yml → error.
- [ ] DOC-SEC-3: `secrets/` not in `.gitignore` → warning.
- [ ] DOC-SEC-4: `secret.*` in `public.promote` → error.
- [ ] DOC-SEC-5: `secret.*` in `envMapping.explicit` → error.
