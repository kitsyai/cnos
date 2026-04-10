# CNOS v1 — Post-Changeset Enhancements

**Context:** These tasks ship after the pre-changeset (namespaces, promotion, singleton, browser runtime, vault CLI, .env bridge) and changeset (codegen, watch, migrate, drift) are complete. They extend CNOS's reach into remote providers, additional frameworks, and deeper migration tooling.

**What's already covered elsewhere:**
- Vault CRUD (`vault create/list/remove`, `secret set/get/list`) → pre-changeset Phase 5.
- No-passphrase vaults and `provider: github-secrets` → pre-changeset Phase 5.
- `SecretVaultProvider` interface → pre-changeset Phase 5.
- Basic `cnos migrate` (scan, propose, apply mappings) → changeset Phase 3.

This document covers only what's left.

---

## 1. Remote Secret Providers

### Problem

Pre-changeset ships a `SecretVaultProvider` interface and a `github-secrets` provider that reads from `process.env`. Real-world production needs providers for managed secret stores — AWS Secrets Manager, HashiCorp Vault, Azure Key Vault, GCP Secret Manager. These providers fetch secrets at resolution time over the network, not from local files or env vars.

### What to build

Ship provider plugins as separate packages. Each implements `SecretVaultProvider` and handles authentication, caching, and error handling for its platform.

### Packages

| Package | Provider | Auth method |
|---------|----------|-------------|
| `@kitsy/cnos-vault-aws` | AWS Secrets Manager | IAM role / access key via AWS SDK |
| `@kitsy/cnos-vault-hashicorp` | HashiCorp Vault | Token / AppRole / Kubernetes auth |
| `@kitsy/cnos-vault-azure` | Azure Key Vault | Managed identity / service principal |
| `@kitsy/cnos-vault-gcp` | GCP Secret Manager | Service account / workload identity |

### Manifest shape

```yaml
vaults:
  local-dev:
    provider: local
    passphrase: env:CNOS_SECRET_PASSPHRASE

  github-ci:
    provider: github-secrets

  aws-prod:
    provider: aws-secrets-manager
    config:
      region: us-east-1
      secretPrefix: /myapp/prod/
```

### Provider contract (extends pre-changeset interface)

```ts
interface RemoteSecretVaultProvider extends SecretVaultProvider {
  /**
   * Test connectivity and authentication.
   * Used by cnos doctor.
   */
  healthCheck(): Promise<{ ok: boolean; message?: string }>;

  /**
   * Cache control. Remote providers should cache secrets
   * for the duration of a single resolution pass.
   */
  clearCache(): void;
}
```

### CLI integration

```bash
cnos vault create aws-prod --provider aws-secrets-manager --region us-east-1
cnos secret list --vault aws-prod
cnos secret get db.password --vault aws-prod
cnos doctor    # includes health check for remote vaults
```

### Implementation notes

- Each provider is a separate npm package with its cloud SDK as a peer dependency.
- Providers cache secrets per-resolution (not across resolutions) to avoid stale reads.
- `cnos doctor` calls `healthCheck()` on all configured vaults and reports connectivity.
- Authentication config can reference env vars: `token: env:VAULT_TOKEN`.
- Error handling: if a remote provider fails, CNOS should report a clear error with the provider name, not a generic network error.

### Tests per provider

- Provider authenticates successfully with valid credentials.
- Provider returns correct secret value.
- Provider throws clear error on authentication failure.
- Provider throws clear error on missing secret.
- Cache clears between resolution passes.
- `cnos doctor` reports health check results.

---

## 2. Webpack + Generic Bundler Integration

### Problem

Vite and Next.js have first-party plugins. Webpack, esbuild, Rollup, and other bundlers do not. Teams using these bundlers need a path to consume CNOS public config at build time.

### What to build

#### 2a. `@kitsy/cnos-webpack`

A Webpack plugin that injects promoted public values using `DefinePlugin`.

```ts
// webpack.config.js
const { CnosWebpackPlugin } = require("@kitsy/cnos-webpack");

module.exports = {
  plugins: [
    new CnosWebpackPlugin({
      // optional overrides
      workspace: "web",
      profile: "stage",
    }),
  ],
};
```

The plugin:
1. Calls `resolveBrowserData()` from `@kitsy/cnos/build` at build time.
2. Converts the result to `DefinePlugin` entries: `"process.env.VITE_APP_API_BASE_URL": JSON.stringify("https://...")`.
3. Also injects `globalThis.__CNOS_BROWSER_DATA__` so the browser runtime works.

#### 2b. Generic bundler adapter

For esbuild, Rollup, or any other bundler, provide a generic helper:

```ts
// In any build script
import { resolveBrowserData } from "@kitsy/cnos/build";
import { toFrameworkEnv } from "@kitsy/cnos/build";

const data = await resolveBrowserData({ profile: "stage" });
const viteEnv = toFrameworkEnv(data, "vite");    // { VITE_APP_API_BASE_URL: "..." }
const nextEnv = toFrameworkEnv(data, "next");     // { NEXT_PUBLIC_APP_API_BASE_URL: "..." }
const rawEnv = toFrameworkEnv(data, "generic");   // { APP_API_BASE_URL: "..." }
```

`toFrameworkEnv()` is a utility in `@kitsy/cnos/build` that takes the resolved browser data and applies the framework prefix from the manifest's `public.frameworks` config.

### Files

```
packages/webpack/
  src/
    index.ts           # CnosWebpackPlugin

packages/cnos/src/
  build/
    index.ts           # add toFrameworkEnv() utility
```

### Tests

- Webpack plugin injects correct `process.env.*` entries.
- Webpack plugin injects `__CNOS_BROWSER_DATA__`.
- `toFrameworkEnv()` applies correct prefix for each framework.
- `toFrameworkEnv()` with `"generic"` strips namespace prefix only.

---

## 3. Deep Migration: End-to-End Env Loader Replacement

### Problem

Changeset `cnos migrate` scans for `process.env.*` and proposes CNOS mappings. But many codebases have deeper custom env loading: `require('dotenv').config()`, custom config modules that read from JSON/YAML, framework-specific config helpers. A full migration needs to identify and replace these patterns end-to-end.

### What to build

Extend `cnos migrate` with a `--deep` flag that goes beyond env var scanning:

```bash
cnos migrate --deep --scan ./src     # deep scan
cnos migrate --deep --dry-run        # preview all changes
cnos migrate --deep --apply          # apply with backups
```

### Deep scan targets

| Pattern | Detection | Replacement |
|---------|-----------|-------------|
| `require('dotenv').config()` | AST match | Remove the require/import |
| `import 'dotenv/config'` | Import detection | Remove the import |
| `config.get('db.host')` (node-config) | Method call pattern | `cnos.value("db.host")` |
| `convict({...}).get('db.host')` | Convict schema pattern | `cnos.value("db.host")` + schema extraction |
| `nconf.get('db:host')` | nconf pattern | `cnos.value("db.host")` |
| Custom `loadConfig()` functions | Heuristic: function returning config-like object | Flag for manual review |

### Implementation notes

- Use a simple AST parser (e.g., `@babel/parser` or `ts-morph`) for deep scanning. The regex scanner from basic migrate is insufficient for import detection.
- Each pattern matcher is a separate module so new patterns can be added.
- `--deep` mode always creates `.bak` files before modifying source.
- Patterns that can't be automatically rewritten (custom loaders, dynamic config) are flagged in the output for manual review.
- Extract convict schemas into CNOS `schema` section where possible.

### Output

```
Deep migration scan of ./src (23 files):

  Auto-replaceable:
    ✓ src/server.ts:1    require('dotenv').config()  → remove
    ✓ src/server.ts:5    process.env.PORT            → cnos.value("server.port")
    ✓ src/db.ts:3        process.env.DATABASE_URL    → cnos.value("db.url")

  Manual review needed:
    ? src/config/index.ts:12  Custom loadConfig() function — cannot auto-replace
    ? src/utils/env.ts:8      Dynamic env key: process.env[key] — cannot auto-replace

  Extracted schema:
    value.server.port: { type: number, required: true }
    value.db.url: { type: string, required: true }

  Apply? [Y/n/edit]
```

### Files to add

```
packages/cnos/src/
  migrate/
    deepScan.ts            # AST-based scanner
    patterns/
      dotenv.ts            # require('dotenv') detection
      nodeConfig.ts        # node-config detection
      convict.ts           # convict detection
      nconf.ts             # nconf detection
    extractSchema.ts       # extract schema from convict/config patterns
```

### Tests

- Detects `require('dotenv').config()`.
- Detects `import 'dotenv/config'`.
- Detects `config.get('db.host')` (node-config).
- Flags custom loader functions for manual review.
- `--dry-run` shows changes without writing.
- `--apply` creates backups and rewrites.
- Extracted schema is valid CNOS schema format.

---

## Summary

| Task | Depends on | Effort | Impact |
|------|------------|--------|--------|
| Remote secret providers (AWS, Hashi, Azure, GCP) | Pre-changeset Phase 5 (vault interface) | Large (per-provider) | High — production secret management |
| `@kitsy/cnos-webpack` | Pre-changeset Phase 4 (browser runtime + build utility) | Small | Medium — Webpack ecosystem |
| Generic bundler adapter (`toFrameworkEnv`) | Pre-changeset Phase 4 | Tiny | Medium — esbuild/Rollup/etc |
| Deep migration (`cnos migrate --deep`) | Changeset Phase 3 (basic migrate) | Large | High — enterprise adoption |

Remote providers and deep migration are the highest-impact items. Webpack and generic adapter are small wins. All four are independent and can be prioritized based on user demand.

---

## 4. Production Logging Integrations

### Problem

`cnos.format(...)` and `cnos.log(...)` now cover direct runtime interpolation, but
production systems usually standardize on structured loggers such as pino or
winston. CNOS should be able to resolve `${logical.key}` placeholders while
delegating the actual transport/output to those logging stacks.

### What to build

Add an adapter surface so CNOS can format messages and then forward them to a
configured logger implementation.

### Initial scope

| Integration | Goal |
|-------------|------|
| `pino` | structured JSON logging with CNOS-resolved message text and metadata |
| `winston` | pluggable transports with CNOS-resolved message text and metadata |
| future | bunyan, morgan, and custom adapters through the same contract |

### Design notes

- Keep `cnos.format(...)` as the core placeholder-resolution primitive.
- Keep `cnos.log(...)` as the zero-dependency default for simple apps.
- Add a separate adapter-based API for production logging rather than forcing a
  logging dependency into `@kitsy/cnos`.
- Structured metadata should remain available alongside the resolved message.

### Tests

- Placeholder interpolation remains identical between default `cnos.log(...)`
  and adapter-backed logging.
- Pino adapter emits the resolved message plus structured metadata.
- Winston adapter emits the resolved message plus structured metadata.
