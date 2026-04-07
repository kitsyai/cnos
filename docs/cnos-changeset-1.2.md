# CNOS v1 — Pre-Changeset Implementation Plan

**Context:** This is a self-contained implementation document for code agent execution. It adds features to the shipped v1 CNOS codebase without structural architecture changes. These features ship before the v1 changeset (codegen, watch, migrate, drift).

**Goal:** Cover the daily use cases — backend server, frontend browser, CI/CD pipelines, deployment runtimes — and fix the namespace/promotion model so that `public.*` and `env` become proper manifest-driven concepts.

**Authority:** The shipped v1 spec (`cnos-spec.md`) remains the base. This document adds to it.

---

## What This Plan Delivers

By the end of all phases, CNOS supports:

1. **Backend:** `cnos run -- node server.js` injects config as env vars. Singleton `cnos("value.db.host")` in code.
2. **Frontend:** `cnos export env --public --framework vite > .env.local` for build-time. `cnos.read("public.flag.auth.upi_enabled")` in browser code via Vite/Next plugin.
3. **CI/CD:** `cnos export env --profile stage > .env.stage` materializes config for pipelines.
4. **Deployment:** `cnos run --profile prod -- node dist/server.js` injects production config.
5. **Safety:** `secret.*` can never be promoted to `public` or `env`. Hard error on attempt.

---

## Phase 1: Manifest-Driven Namespaces

### Problem

Namespaces (`value`, `secret`, `meta`) are currently hardcoded in the core engine. `public` and `env` are treated as special projection logic, not as namespace concepts. This means:

- You can't `cnos.read("public.flag.auth.upi_enabled")` — there's no `public.*` in the resolved graph.
- There's no unified model for what can be shared where.
- Adding new namespace surfaces (like `flag.*` in the future) requires code changes, not config changes.

### What to build

Make namespaces manifest-driven with sensible defaults. Introduce `public.*` as a real readable namespace populated by promotion. Keep `secret.*` and `meta.*` as built-in namespaces with special rules.

### Manifest shape

Add a `namespaces` block to `.cnos/cnos.yml`:

```yaml
namespaces:
  value:
    kind: data
    shareable: true          # can be promoted to public/env
  secret:
    kind: data
    shareable: false          # can NEVER be promoted
    sensitive: true
  meta:
    kind: system
    shareable: false
    readonly: true
  public:
    kind: projection
    source: promote           # populated from public.promote rules
    shareable: true
  env:
    kind: projection
    source: envMapping        # populated from envMapping.explicit rules
    shareable: true
```

### Default behavior

If no `namespaces` block is present in the manifest, CNOS uses exactly the defaults above. Zero migration needed for existing projects. The defaults are derived, not hardcoded — the resolver reads the namespace definitions from the normalized manifest.

### How it works

1. **Manifest loads.** Namespace definitions are normalized (defaults applied if block is absent).
2. **Loaders run.** They produce `value.*`, `secret.*` entries as before.
3. **Promotion runs.** For each key in `public.promote`, if the key's namespace has `shareable: true`, a mirrored entry is created under `public.*`. Example: `value.flag.auth.upi_enabled` → `public.flag.auth.upi_enabled`.
4. **Env projection runs.** For each entry in `envMapping.explicit`, if the key's namespace has `shareable: true`, an entry is available in the env export surface.
5. **Validation.** If any `secret.*` key (or any namespace with `sensitive: true`) appears in `public.promote` or `envMapping.explicit`, throw `CnosSecurityError` immediately.

### Runtime reads

After this change:

```ts
const cnos = await createCnos();

// Existing — unchanged
cnos.read("value.flag.auth.upi_enabled");      // works
cnos.value("flag.auth.upi_enabled");            // works

// NEW — public namespace is readable
cnos.read("public.flag.auth.upi_enabled");      // works (promoted value)
cnos.read("public.app.api_base_url");            // works (promoted value)

// Still blocked
cnos.read("public.db.password");                 // ERROR: secret.db.password cannot be promoted
```

### Type changes

```ts
// Update NamespaceName — no longer a fixed union
type NamespaceName = string;

// Namespace definition (internal)
interface NamespaceDefinition {
  kind: "data" | "projection" | "system";
  shareable: boolean;
  sensitive?: boolean;
  readonly?: boolean;
  source?: "promote" | "envMapping";  // for projection namespaces
}
```

### CLI addition: `cnos promote`

```bash
# Promote a single key to public
cnos promote value.flag.auth.upi_enabled --to public

# Promote multiple keys
cnos promote value.app.api_base_url value.app.name --to public

# Promote to env export
cnos promote value.server.port --to env --as PORT

# Attempt to promote secret — hard error
cnos promote secret.db.password --to public
# ERROR: Cannot promote secret.db.password — namespace "secret" is sensitive and not shareable.
```

`cnos promote --to public` adds the key to `public.promote` in `cnos.yml`.
`cnos promote --to env --as VAR_NAME` adds the mapping to `envMapping.explicit` in `cnos.yml`.

### Files to change/add

```
packages/cnos/src/
  types/
    core.ts                    # NamespaceName → string, add NamespaceDefinition
    manifest.ts                # add namespaces block to manifest type
  manifest/
    normalizeManifest.ts       # apply namespace defaults when block is absent
  orchestrator/
    pipeline.ts                # add promotion step after resolution
  promotions/                  # NEW module
    promoteToPublic.ts         # create public.* mirror entries from public.promote
    promoteToEnv.ts            # validate env mappings against namespace rules
    validatePromotion.ts       # security: reject sensitive namespace promotion
  validators/
    publicSafety.ts            # update: use namespace definitions for shareable/sensitive checks

packages/cli/src/
  commands/
    promote.ts                 # NEW: cnos promote command
```

### Tests

- [ ] Manifest without `namespaces` block → defaults applied correctly.
- [ ] `value.flag.auth.upi_enabled` in `public.promote` → `public.flag.auth.upi_enabled` exists in resolved graph.
- [ ] `cnos.read("public.flag.auth.upi_enabled")` returns the promoted value.
- [ ] `secret.db.password` in `public.promote` → `CnosSecurityError` thrown.
- [ ] `secret.db.password` in `envMapping.explicit` → `CnosSecurityError` thrown.
- [ ] Custom namespace with `sensitive: true` → promotion blocked.
- [ ] Custom namespace with `shareable: true` → promotion allowed.
- [ ] `cnos promote value.x --to public` adds to `public.promote` in manifest.
- [ ] `cnos promote secret.x --to public` → error.
- [ ] `cnos promote value.x --to env --as MY_VAR` adds to `envMapping.explicit`.

---

## Phase 2: `.env` Export Bridge + Profile-Targeted Export

### Problem

CI/CD pipelines and deployment platforms expect `.env` files. Current `cnos export env` writes to stdout but has no `--to` flag for file output, and profile-targeted export needs to be seamless.

### What to build

Enhance `cnos export env` with `--to` flag and ensure profile-targeted exports work cleanly for all daily use cases.

### Commands

```bash
# Backend: explicit env mappings to file
cnos export env --to .env.local
cnos export env --profile stage --to .env.stage
cnos export env --profile prod --to .env.prod

# Frontend: public-only, framework-prefixed
cnos export env --public --framework vite --to .env.local
cnos export env --public --framework vite --profile stage --to .env.stage
cnos export env --public --framework next --profile prod --to .env.production

# CI/CD: pipe to stdout (existing behavior, unchanged)
cnos export env --profile stage > .env.stage

# List what would be exported
cnos list env                    # shows explicit env mappings
cnos list public                 # shows promoted public keys
cnos list public --framework vite  # shows with VITE_ prefix
```

### `--to` implementation

When `--to <path>` is provided:
1. Resolve config for the specified profile/workspace.
2. Generate `KEY=VALUE\n` formatted output.
3. Write to the specified file path.
4. Print confirmation: `Wrote 12 env vars to .env.stage`

When `--to` is absent, output goes to stdout (existing behavior preserved).

### Output format

Pure `KEY=VALUE` lines. No comments, no CNOS metadata, no blank lines between entries. This ensures compatibility with every tool that reads `.env` files (Docker Compose, Vercel, Heroku, GitHub Actions).

```
APP_NAME=my-service
API_BASE_URL=https://api.kitsy.ai
PORT=3000
```

For public export with framework prefix:

```
VITE_APP_API_BASE_URL=https://api.kitsy.ai
VITE_APP_NAME=my-service
VITE_FLAG_AUTH_UPI_ENABLED=true
```

### Files to change

```
packages/cli/src/
  commands/
    export.ts              # add --to flag, file write logic
    list.ts                # add --framework flag to list public
```

### Tests

- [ ] `cnos export env --to .env.local` writes correct file.
- [ ] `cnos export env --profile stage --to .env.stage` uses stage profile.
- [ ] `cnos export env --public --framework vite --to .env.vite` writes VITE_-prefixed keys.
- [ ] `cnos export env --public --framework next --to .env.next` writes NEXT_PUBLIC_-prefixed keys.
- [ ] Output is pure KEY=VALUE format, no extra lines.
- [ ] `cnos list public --framework vite` shows prefixed keys.
- [ ] Without `--to`, output goes to stdout (backward compat).

---

## Phase 3: Singleton Runtime + `cnos run` Enhancement

### Problem

Every file that uses CNOS needs `const cnos = await createCnos()`. This is friction for apps with many modules. Additionally, `cnos run` should be the hero adoption command — zero code changes, just inject config as env vars.

### 3a. `cnos run` as the hero command

`cnos run` already exists. Enhance it:

```bash
# Basic: inject resolved env into child process
cnos run -- node server.js

# With profile
cnos run --profile stage -- node server.js

# With CLI override
cnos run --set value.server.port=8080 -- node server.js

# Build-time: inject only public env for frontend build
cnos run --public --framework vite -- pnpm build
cnos run --public --framework next -- pnpm build
```

**`--set` flag:** Allows inline overrides without touching config files. `--set value.server.port=8080` is equivalent to `--value.server.port=8080` in the CLI args loader but more readable.

**`--public` flag:** When present, `cnos run` injects only promoted public keys (with framework prefix if specified) into the child process env. This is for frontend build commands that should only see public config.

**Graph injection:** When `cnos run` spawns the child process, it also sets `process.env.__CNOS_GRAPH__` to a JSON-serialized copy of the resolved graph. This enables the singleton runtime (Phase 3b) to boot synchronously.

### 3b. Singleton runtime

Add `@kitsy/cnos/runtime` as a subpath export that provides synchronous, singleton access:

```ts
// @kitsy/cnos/runtime
import type { LogicalKey } from "@kitsy/cnos";

interface CnosSingleton {
  (key: LogicalKey): unknown;               // cnos("value.server.port")
  read<T = unknown>(key: LogicalKey): T | undefined;
  require<T = unknown>(key: LogicalKey): T;
  readOr<T>(key: LogicalKey, fallback: T): T;
  value<T = unknown>(path: string): T | undefined;
  secret<T = unknown>(path: string): T | undefined;
  meta<T = unknown>(path: string): T | undefined;
  ready(): Promise<void>;
}
```

**How it initializes:**

1. **Fast path (from `cnos run`):** If `process.env.__CNOS_GRAPH__` exists, parse it synchronously. All reads work immediately, no async needed.
2. **Async path (standalone import):** If no injected graph, `cnos.ready()` calls `createCnos()` internally. Reads before `ready()` completes throw: `"CNOS not initialized. Call await cnos.ready() or use cnos run."`.
3. **Explicit path:** If `createCnos()` was already called elsewhere, the singleton can attach to that instance.

**Usage:**

```ts
// After cnos run — synchronous, no await needed
import cnos from "@kitsy/cnos/runtime";
const port = cnos("value.server.port");       // works immediately
const host = cnos.value("db.host");            // works immediately

// Standalone — async init required
import cnos from "@kitsy/cnos/runtime";
await cnos.ready();
const port = cnos("value.server.port");
```

**The callable function:** `cnos("value.server.port")` is shorthand for `cnos.read("value.server.port")`. The singleton is both a function and an object with methods.

### Files to add/change

```
packages/cnos/src/
  runtime/
    index.ts                # singleton implementation
    bootstrap.ts            # graph parsing from __CNOS_GRAPH__
  index.ts                  # add /runtime subpath export

packages/cli/src/
  commands/
    run.ts                  # add --set, --public, __CNOS_GRAPH__ injection

package.json exports:
  "./runtime": "./dist/runtime/index.js"
```

### Tests

- [ ] `cnos run -- node -e "console.log(process.env.PORT)"` outputs correct value.
- [ ] `cnos run --profile stage -- node -e "..."` uses stage config.
- [ ] `cnos run --set value.server.port=9999 -- node -e "..."` overrides port.
- [ ] `cnos run --public --framework vite -- node -e "..."` injects only VITE_-prefixed keys.
- [ ] `process.env.__CNOS_GRAPH__` is set when `cnos run` spawns child.
- [ ] Singleton reads work immediately when bootstrapped from `__CNOS_GRAPH__`.
- [ ] Singleton `cnos("value.server.port")` returns correct value.
- [ ] Singleton `cnos.value("server.port")` returns correct value.
- [ ] Singleton throws clear error when read before `ready()` without `cnos run`.
- [ ] `cnos.ready()` resolves successfully in standalone mode.

---

## Phase 4: Browser Runtime + Public Namespace Reads

### Problem

Frontend code needs to read promoted config values. Currently, Vite/Next plugins inject env vars, but there's no CNOS runtime for the browser. Developers can't write `cnos.read("public.flag.auth.upi_enabled")` in browser code.

### What to build

A lightweight browser runtime at `@kitsy/cnos/browser` that reads from build-time embedded data. Only keys in the `public.*` namespace (populated by promotion in Phase 1) are available.

### Browser runtime module

```ts
// @kitsy/cnos/browser

const data: Record<string, unknown> = JSON.parse(
  globalThis.__CNOS_BROWSER_DATA__ ?? "{}"
);

function read<T = unknown>(key: string): T | undefined {
  // Allow both "public.flag.auth.upi_enabled" and "value.flag.auth.upi_enabled"
  // Normalize: strip "public." prefix if present, look up in data
  const normalized = key.startsWith("public.") ? key : `public.${key.replace(/^value\./, "")}`;
  if (key.startsWith("secret.")) {
    throw new Error(`CNOS: secret.* keys are not available in the browser.`);
  }
  return data[normalized] as T | undefined;
}

function require<T = unknown>(key: string): T {
  const val = read<T>(key);
  if (val === undefined) throw new Error(`CNOS: key "${key}" not found in browser config.`);
  return val;
}

// Callable function
const cnos = Object.assign(
  (key: string) => read(key),
  { read, require, toObject: () => ({ ...data }) }
);

export default cnos;
export { read, require };
```

### Build-time data embedding

Add a utility that bundler plugins use to resolve the browser data:

```ts
// @kitsy/cnos/build

import { createCnos } from "@kitsy/cnos";

export async function resolveBrowserData(options?: {
  root?: string;
  workspace?: string;
  profile?: string;
}): Promise<Record<string, unknown>> {
  const cnos = await createCnos(options);
  const graph = cnos.graph;
  const browserData: Record<string, unknown> = {};

  // Collect all public.* entries (populated by promotion in Phase 1)
  for (const [key, entry] of graph.entries) {
    if (key.startsWith("public.")) {
      browserData[key] = entry.value;
    }
  }

  return browserData;
}
```

### Bundler plugin updates

Refactor `@kitsy/cnos-vite` and `@kitsy/cnos-next` to use this utility:

```ts
// @kitsy/cnos-vite (simplified)
import { resolveBrowserData } from "@kitsy/cnos/build";

export function createCnosVitePlugin(options?: { workspace?: string; profile?: string }) {
  return {
    name: "cnos-vite",
    async config() {
      const data = await resolveBrowserData(options);
      return {
        define: {
          "globalThis.__CNOS_BROWSER_DATA__": JSON.stringify(JSON.stringify(data)),
        },
      };
    },
  };
}
```

This means the developer can now do:

```ts
// In browser code
import cnos from "@kitsy/cnos/browser";

const apiUrl = cnos("public.app.api_base_url");       // works
const flag = cnos("public.flag.auth.upi_enabled");     // works
const secret = cnos("secret.db.password");              // throws
```

AND still get framework-specific env vars:

```ts
// Also works — the Vite/Next plugins still inject these
console.log(import.meta.env.VITE_APP_API_BASE_URL);
console.log(process.env.NEXT_PUBLIC_FLAG_AUTH_UPI_ENABLED);
```

Both paths work simultaneously. The browser runtime is for CNOS-native code. The framework env vars are for compatibility with existing patterns.

### Files to add

```
packages/cnos/src/
  browser/
    index.ts               # browser runtime
  build/
    index.ts               # resolveBrowserData

package.json exports:
  "./browser": "./dist/browser/index.js"
  "./build": "./dist/build/index.js"
```

### Tests

- [ ] Browser runtime `cnos("public.flag.auth.upi_enabled")` returns promoted value.
- [ ] Browser runtime `cnos("secret.db.password")` throws.
- [ ] Browser runtime `cnos.require("public.nonexistent")` throws.
- [ ] `resolveBrowserData()` returns only `public.*` keys.
- [ ] Vite plugin injects `__CNOS_BROWSER_DATA__` with correct data.
- [ ] Next plugin injects `__CNOS_BROWSER_DATA__` with correct data.
- [ ] Framework env vars (`VITE_*`, `NEXT_PUBLIC_*`) still work alongside browser runtime.

---

## Phase 5: Vault CLI Refinement

### Problem

Current vault commands are verbose. CI/CD needs passwordless access.

### Commands

```bash
# Simplified vault management
cnos vault create local-dev --passphrase dev-pass
cnos vault create github-ci --provider github-secrets --no-passphrase
cnos vault list
cnos vault remove local-dev

# Secret management using vaults
cnos secret set db.password super-secret --vault local-dev
cnos secret get db.password --vault local-dev
cnos secret list --vault github-ci
```

### Provider interface

Add a vault provider interface so remote secret providers (GitHub Actions, AWS SSM) can be plugged in:

```ts
interface SecretVaultProvider {
  id: string;
  requiresPassphrase: boolean;
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  list(): Promise<string[]>;
}
```

For `provider: github-secrets`, the provider reads from `process.env` directly — GitHub Actions injects secrets as env vars. No passphrase, no encryption. The provider just maps the env var name to the logical secret ref.

### Manifest shape

```yaml
vaults:
  local-dev:
    provider: local
    passphrase: env:CNOS_SECRET_PASSPHRASE
  github-ci:
    provider: github-secrets
```

### Tests

- [ ] `cnos vault create` writes to manifest.
- [ ] `--no-passphrase` with `github-secrets` provider works.
- [ ] `cnos secret set` with vault works.
- [ ] GitHub secrets provider reads from process.env.
- [ ] `cnos secret list --vault github-ci` lists available secrets.

---

## Daily Use Case Verification

After all phases, verify these end-to-end scenarios:

### Use Case 1: Backend server

```bash
cnos init
cnos value set server.port 3000
cnos value set db.host localhost
cnos secret set db.password s3cr3t --vault local-dev
cnos run -- node server.js
```

In server code:
```ts
import cnos from "@kitsy/cnos/runtime";
const port = cnos("value.server.port");    // 3000
const host = cnos.value("db.host");        // "localhost"
const pass = cnos.secret("db.password");   // "s3cr3t"
```

### Use Case 2: Frontend with Vite

```bash
cnos value set app.api_base_url https://api.kitsy.ai
cnos value set flag.auth.upi_enabled true
cnos promote value.app.api_base_url --to public
cnos promote value.flag.auth.upi_enabled --to public
cnos export env --public --framework vite --to .env.local
```

In browser code:
```ts
import cnos from "@kitsy/cnos/browser";
const api = cnos("public.app.api_base_url");
const flag = cnos("public.flag.auth.upi_enabled");
```

### Use Case 3: CI/CD pipeline

```yaml
# GitHub Actions
steps:
  - run: cnos export env --profile stage --to .env.stage
  - run: cnos export env --public --framework vite --profile stage --to .env.vite
  - run: cnos run --profile stage -- pnpm build
```

### Use Case 4: Deployment

```bash
cnos run --profile prod -- node dist/server.js
```

### Use Case 5: Fail-fast validation

```ts
import cnos from "@kitsy/cnos/runtime";
await cnos.ready();

// All required keys validated at resolution time
// If schema says value.server.port is required and missing → error before app starts

const port = cnos.require("value.server.port");  // throws if missing
```

---

## Implementation Order Summary

| Phase | What | Depends on |
|-------|------|------------|
| 1 | Manifest-driven namespaces + `public.*` promotion + `cnos promote` | Nothing |
| 2 | `.env` export `--to` + profile-targeted export | Phase 1 |
| 3 | Singleton runtime + `cnos run` enhancement | Phase 1 |
| 4 | Browser runtime + build-time embedding | Phase 1, Phase 3 |
| 5 | Vault CLI refinement | Nothing (can parallel) |

Phases 1-4 are sequential. Phase 5 is independent and can be parallelized.
