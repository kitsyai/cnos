# CNOS — Monorepo Runtime Projection, Safe Discovery, and Workspace Attach/Detach

**Status:** Implementation-ready. No backward compatibility considerations.
**Scope:** `cnos` repo only.

---

## 1. What This Solves

In a pnpm monorepo:

```
heypkv/
  .cnos/
    cnos.yml
    workspaces/
      travel/
      food/
      api/
  apps/
    travel/
      .cnosrc.yml           ← anchor: "I belong to ../../.cnos, workspace: travel"
      package.json
      src/
    food/
      .cnosrc.yml           ← anchor: "I belong to ../../.cnos, workspace: food"
      package.json
  packages/
    shared/                  ← no .cnosrc.yml = no CNOS config
      package.json
```

**Problem A — Discovery must be safe.** Unbounded upward walk risks finding unintended `.cnos/` directories. Discovery must be explicit and deterministic.

**Problem B — Runtime needs a flat projection.** Production servers don't need the full `.cnos/` tree. They need a flat payload: resolved values + secret refs. Same concept as browser projection, but for server.

**Problem C — Projection should auto-load.** `import cnos from "@kitsy/cnos"` should work without manual `loadProjection()` calls. The runtime discovers its config source automatically.

**Problem D — Multiple projection formats.** Different consumers need different shapes: JSON for server runtime, `.env` for Docker/CI, framework-specific env for Vite/Next, JSON for future formats.

---

## 2. Core Design: Anchor-Based Discovery

### 2.1 The anchor file: `.cnosrc.yml`

Every package/app that uses CNOS must have a `.cnosrc.yml` at its root. This file is the **sole authority** for where that package's CNOS config comes from. There is no upward walk, no guessing, no implicit discovery.

```yaml
# apps/travel/.cnosrc.yml

# Option A: part of a workspace root
root: ../../.cnos
workspace: travel

# Option B: self-contained (standalone project or detached package)
root: ./.cnos
```

That's it. Two fields. `root` is the path to the `.cnos/` directory (relative to this file). `workspace` is the workspace ID within that root (optional — omit for single-workspace projects).

### 2.2 Why this is better than upward walk

| Concern | Upward walk | Anchor file |
|---------|-------------|-------------|
| Determinism | Could find wrong `.cnos/` in parent dirs | Always resolves to declared root |
| Auditability | Must trace the walk to know which root was used | Read one file to know |
| Safety | Unintended `.cnos/` in `$HOME` could silently win | Impossible — anchor is explicit |
| Monorepo | Works but fragile | Works and explicit |
| Standalone | Works | Works — `root: ./.cnos` |
| Detached package | Works by accident (nearest wins) | Works by design — anchor changes |

### 2.3 Discovery algorithm

```
discoverConfig(startDir: string): { manifestRoot: string, workspace?: string }

  1. Look for .cnosrc.yml in startDir.
  2. If not found, look in startDir's parent, then grandparent, up to 3 levels max.
     (This handles `import cnos from "@kitsy/cnos"` called from src/server/index.ts
      where .cnosrc.yml is at the package root, 2 levels up.)
  3. If still not found: throw CnosDiscoveryError:
     "No .cnosrc.yml found. Run cnos init or create .cnosrc.yml in your package root."
  4. Read .cnosrc.yml. Resolve `root` relative to the .cnosrc.yml location.
  5. Verify <resolved-root>/cnos.yml exists.
     If not: throw CnosDiscoveryError: ".cnosrc.yml points to <path> but no cnos.yml found there."
  6. Return { manifestRoot: resolvedRoot, workspace: rcFile.workspace }
```

**Key rule: the walk is bounded to 3 levels and only looks for `.cnosrc.yml`, never for `.cnos/`.** This is not a filesystem-root walk. It's a package-root search. Most projects have `.cnosrc.yml` at the package root (alongside `package.json`), and code files are 1-2 levels deep inside `src/`.

### 2.4 `cnos init` creates the anchor

When you run `cnos init` in a standalone project:
```bash
cnos init
# Creates:
#   .cnos/cnos.yml
#   .cnosrc.yml  → { root: "./.cnos" }
```

When you run `cnos init --workspace travel` in a monorepo child:
```bash
cd apps/travel
cnos init --workspace travel --root ../../.cnos
# Creates:
#   .cnosrc.yml  → { root: "../../.cnos", workspace: "travel" }
# Does NOT create .cnos/ here — config lives at repo root
```

When you run `cnos init` at the monorepo root:
```bash
cnos init --workspaces travel,food,api
# Creates:
#   .cnos/cnos.yml (with workspaces block)
#   .cnos/workspaces/travel/...
#   .cnos/workspaces/food/...
#   .cnos/workspaces/api/...
# Does NOT create .cnosrc.yml at root — the root is the author, not a consumer
```

### 2.5 CreateCnosOptions update

```ts
interface CreateCnosOptions {
  /** Start directory for .cnosrc.yml search. Default: process.cwd() */
  cwd?: string;
  /** Override: direct path to .cnos/ directory. Skips discovery. */
  root?: string;
  /** Override: workspace ID. Takes priority over .cnosrc.yml */
  workspace?: string;
  profile?: string;
  globalRoot?: string;
  plugins?: CnosPlugin[];
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
  secretResolution?: "eager" | "lazy" | "refreshing";
  secretRefreshTtl?: number;
}
```

If `root` is provided, discovery is skipped entirely (explicit mode for testing and advanced use). Otherwise, discovery runs from `cwd`.

---

## 3. Server Runtime Projection

### 3.1 Projection shape

```ts
interface ServerProjection {
  version: 1;
  workspace: string;
  profile: string;
  resolvedAt: string;
  configHash: string;              // SHA-256 of sorted values JSON

  values: Record<string, unknown>; // "server.port" → 3000 (value.* prefix stripped)
  secretRefs: Record<string, SecretRef>;  // "db.password" → { provider, vault, ref }
  publicKeys: string[];            // promoted keys (prefix-stripped)

  meta: {
    workspace: string;
    profile: string;
    cnos_version: string;
  };
}

interface SecretRef {
  provider: string;
  vault: string;
  ref: string;
}
```

**Invariants:**
- `values` contains resolved `value.*` entries, prefix-stripped.
- `secretRefs` contains `secret.*` entries as refs only. **Never plaintext.**
- `publicKeys` enables the browser runtime to cross-validate.
- No provenance, no override chains, no file paths. Production minimal.
- `configHash` is deterministic: `sha256(JSON.stringify(sortKeys(values)))`.

### 3.2 Generating a projection

```ts
interface CnosRuntime {
  // ... existing ...
  toServerProjection(): ServerProjection;
}
```

### 3.3 Namespace access control in projections

Each projection format enforces namespace boundaries:

| Projection type | What it contains | What it blocks |
|----------------|------------------|----------------|
| Server | `value.*`, `secret.*` refs, `meta.*` | Nothing (server sees all) |
| Browser | Only promoted `value.*` + promotable custom namespaces | `secret.*`, non-promoted `value.*` |
| Env | Only keys in `envMapping.explicit` | Everything not explicitly mapped |
| Public env | Only `public.promote` keys | `secret.*`, non-promoted |

Future namespace-level security (e.g., `internal.*` namespace that only certain services can read) will be enforced at the projection level — the projection generator filters based on namespace access rules, and the consumer runtime cannot bypass the filter because it only has the projection, not the source data.

---

## 4. Projection Delivery and Auto-Discovery

### 4.1 Delivery formats

CNOS produces projections in multiple formats for different consumers:

```bash
# Server runtime projection (JSON)
cnos build server --to .cnos-server.json
cnos build server --workspace travel --profile prod --to dist/.cnos-server.json

# Browser projection (JSON, already exists via resolveBrowserData)
cnos build browser --to .cnos-browser.json

# Env file projection
cnos build env --to .env.generated
cnos build env --profile prod --to .env.prod

# Public env projection (framework-prefixed)
cnos build public --framework vite --to .env.vite
cnos build public --framework next --to .env.next

# Docker env-file format
cnos build env --profile prod --format docker-env --to docker.env

# JSON env (for programmatic consumption)
cnos build env --profile prod --format json --to env.json
```

The `cnos build` command is the unified projection generator. Subcommands:
- `server` — full server projection (values + secret refs)
- `browser` — promoted-only projection for frontend
- `env` — env variable flat file
- `public` — promoted env variables with framework prefix

### 4.2 Industry-standard formats beyond `.env`

| Format | Flag | Use case | Shape |
|--------|------|----------|-------|
| `.env` | `--format dotenv` (default) | Docker Compose, Heroku, Vercel, most CI | `KEY=value\n` |
| Docker env-file | `--format docker-env` | `docker run --env-file` | `KEY=value\n` (same as dotenv but no quotes) |
| JSON | `--format json` | Programmatic consumption, K8s ConfigMaps | `{ "KEY": "value" }` |
| Shell export | `--format shell` | `source .env.sh` in bash scripts | `export KEY="value"\n` |
| YAML | `--format yaml` | K8s ConfigMaps, Helm values | Standard YAML map |
| TOML | `--format toml` | Rust ecosystem, some config tools | `KEY = "value"` |

Default format is `dotenv` for `env` and `public` subcommands, `json` for `server` and `browser`.

### 4.3 Auto-discovery by the runtime

When `import cnos from "@kitsy/cnos"` is called in a server process, the runtime auto-discovers its config source in this priority order:

```
1. __CNOS_PROJECTION__ env var (set by cnos run)
   → Parse JSON, bootstrap from projection

2. Projection file at well-known path
   → Look for .cnos-server.json in:
     a. Directory of .cnosrc.yml (if found)
     b. process.cwd()
     c. Directory containing the importing module (import.meta.dirname)
   → Parse JSON, bootstrap from projection

3. Full resolution from .cnos/ directory
   → Find .cnosrc.yml via bounded search
   → Resolve manifest, workspace, profile, loaders
   → Full pipeline
```

**The well-known filename is `.cnos-server.json`.** It is not hashed, not renamed by bundlers, and not configurable. This is intentional — a well-known name means zero config for discovery.

For the browser runtime (`@kitsy/cnos/browser`), the data is embedded by the bundler plugin at build time into `globalThis.__CNOS_BROWSER_DATA__`. No file discovery needed — the bundler handles injection.

### 4.3.1 Production bootstrap for standalone/server containers

For production deployments where the server process may run from `.next` or other nested output directories, set:

```
CNOS_SERVER_PROJECTION_PATH=/app/.cnos-server.json
CNOS_REQUIRE_SERVER_PROJECTION=1
```

`CNOS_SERVER_PROJECTION_PATH` pins the exact projection file to load, and `CNOS_REQUIRE_SERVER_PROJECTION` stops startup from silently falling back to other resolution paths when that projection is missing or invalid.

### 4.4 `cnos.loadProjection()` for explicit control

For advanced use cases (custom paths, testing, non-standard deployment):

```ts
import cnos from "@kitsy/cnos";
cnos.loadProjection("./custom/path/config.json");
```

This is the "for nerds" escape hatch. Normal users never call it.

### 4.5 `cnos run` uses projection

`cnos run` resolves the full graph, generates a `ServerProjection`, and injects it as `__CNOS_PROJECTION__`:

```bash
cnos run -- node server.js
# Child env: __CNOS_PROJECTION__ = <projection JSON>

cnos run --auth -- node server.js
# Child env: __CNOS_PROJECTION__ + __CNOS_VAULT_KEY_<id>__ for each vault
```

---

## 5. Secret-Safe Delivery

### 5.1 Hard rules

1. **Server projections never contain decrypted secrets.** `secretRefs` contains `{ provider, vault, ref }` objects.
2. **Browser projections never contain `secret.*` keys at all.** Not even refs.
3. **Env projections never contain `secret.*` keys unless explicitly mapped AND the runtime hydrates them.** `cnos build env` writes `SECRET_DB_PASSWORD=****` for mapped secrets. The actual value is hydrated at runtime.
4. **No projection format, in any delivery mode, ever contains plaintext secret values.**

### 5.2 Secret hydration at runtime

When the runtime boots from a projection (env var or file), secrets are refs. Hydration policy:

| Policy | When secrets are fetched | Use case |
|--------|------------------------|----------|
| `eager` | During `createCnos()` / `cnos.ready()` | Production servers — fail fast if vault is unreachable |
| `lazy` | On first `cnos.secret()` call per vault | Dev/test — not all vaults may be configured |
| `refreshing` | At startup + after TTL expiry | Long-running servers with rotating credentials |

### 5.3 Runtime APIs for secret lifecycle

```ts
interface CnosRuntime {
  // ... existing read/value/secret/meta ...

  /** Force re-hydrate all secrets from providers. */
  refreshSecrets(): Promise<void>;

  /** Force re-hydrate a single secret. */
  refreshSecret(key: string): Promise<void>;

  /** Generate server projection. */
  toServerProjection(): ServerProjection;
}
```

### 5.4 Env projection with secrets

When `cnos build env` encounters a mapped secret:

```bash
cnos build env --to .env.prod
# Output includes:
# DB_PASSWORD=****
```

The `****` placeholder signals "this value must be provided by the runtime environment." In CI/CD, the actual value comes from the platform's secret injection (GitHub Actions secrets, AWS SSM, etc.), not from the CNOS projection file.

For `cnos run`, which hydrates secrets at process start:

```bash
cnos run --auth -- node server.js
# Child process.env.DB_PASSWORD = "actual-secret-value" (hydrated from vault)
```

---

## 6. Workspace Detach / Attach

### 6.1 `cnos workspace detach`

Materializes the effective workspace view into a standalone `.cnos/` at the child package.

```bash
cd apps/travel
cnos workspace detach

# Or from repo root
cnos workspace detach --package-root apps/travel
```

**What it does:**

1. Read `apps/travel/.cnosrc.yml` to find current root and workspace.
2. Resolve the effective config for that workspace.
3. Create `apps/travel/.cnos/` with:
   - `cnos.yml` — standalone manifest (no `workspaces` block)
   - `values/`, `secrets/`, `env/`, `profiles/` — snapshot of effective config
4. Update `apps/travel/.cnosrc.yml`:
   ```yaml
   root: ./.cnos
   # workspace field removed — now self-contained
   ```
5. Write `apps/travel/.cnos/.detached` marker:
   ```yaml
   detachedFrom: ../../.cnos
   detachedWorkspace: travel
   detachedAt: "2026-04-11T10:00:00Z"
   originalCnosrc:
     root: ../../.cnos
     workspace: travel
   ```

**After detach:** The package resolves from its own `.cnos/`. Parent changes don't affect it. It can be moved to a separate repo.

**Safety:**
- Refuses if `apps/travel/.cnos/` already exists (unless `--force`).
- Writes a complete snapshot — no dangling references to parent.
- The `.detached` marker preserves the information needed to reattach.

### 6.2 `cnos workspace attach`

Imports a detached package back into the parent workspace.

```bash
cd apps/travel
cnos workspace attach

# Or from repo root
cnos workspace attach --package-root apps/travel
```

**What it does:**

1. Read `.detached` marker from `apps/travel/.cnos/`. If absent → error: "This package was not detached by CNOS."
2. Read `originalCnosrc` from marker to determine parent root and workspace ID.
3. Verify parent manifest root exists.
4. If `workspaces.items.<workspace>` exists in parent:
   - Fail unless `--force`.
5. Import child config into parent `workspaces/<id>/`.
6. Archive `apps/travel/.cnos/` → `apps/travel/.cnos.detached.bak/`.
7. Restore `apps/travel/.cnosrc.yml` to original:
   ```yaml
   root: ../../.cnos
   workspace: travel
   ```

**Safety:**
- No merge heuristics. Import replaces or creates.
- `--force` required to overwrite existing workspace.
- `.detached` marker required — prevents accidental import of unrelated `.cnos/`.

---

## 7. Module Layout

### New files

```
packages/cnos/src/
  discovery/
    findCnosrc.ts               # bounded search for .cnosrc.yml (max 3 levels)
    parseCnosrc.ts              # parse and validate .cnosrc.yml
    resolveManifestRoot.ts      # resolve root path from .cnosrc.yml
  projection/
    serverProjection.ts         # toServerProjection()
    projectionHash.ts           # SHA-256 config hash
    formats/
      dotenv.ts                 # KEY=value format
      json.ts                   # JSON format
      shell.ts                  # export KEY="value" format
      yaml.ts                   # YAML map format
      dockerEnv.ts              # docker --env-file format
      toml.ts                   # TOML format
  runtime/
    index.ts                    # UPDATED: auto-discovery chain
    loadProjection.ts           # parse projection from env/file
    secretHydration.ts          # eager/lazy/refreshing
    autoDiscover.ts             # __CNOS_PROJECTION__ → .cnos-server.json → full resolution

packages/cli/src/
  commands/
    build.ts                    # cnos build server|browser|env|public
    workspace.ts                # UPDATED: detach/attach subcommands
    init.ts                     # UPDATED: creates .cnosrc.yml
  workspace/
    detach.ts
    attach.ts
```

---

## 8. CLI Reference

### 8.1 `cnos build`

```bash
cnos build server --to .cnos-server.json
cnos build server --workspace travel --profile prod --to dist/.cnos-server.json
cnos build server --to .cnos-server.json --with-provenance .cnos-provenance.json

cnos build browser --to .cnos-browser.json

cnos build env --to .env.generated
cnos build env --profile prod --to .env.prod
cnos build env --profile prod --format shell --to env.sh
cnos build env --profile prod --format json --to env.json
cnos build env --profile prod --format yaml --to env.yaml
cnos build env --profile prod --format docker-env --to docker.env

cnos build public --framework vite --to .env.vite
cnos build public --framework next --to .env.next
cnos build public --framework vite --format json --to public.json
```

### 8.2 `cnos workspace detach`

```bash
cnos workspace detach
cnos workspace detach --package-root apps/travel
cnos workspace detach --force
```

### 8.3 `cnos workspace attach`

```bash
cnos workspace attach
cnos workspace attach --package-root apps/travel
cnos workspace attach --force
```

---

## 9. Test Plan

### 9.1 Anchor-based discovery

- [ ] DISC-1: `.cnosrc.yml` at cwd → resolved correctly.
- [ ] DISC-2: `.cnosrc.yml` 1 level up from cwd (code in `src/`) → found.
- [ ] DISC-3: `.cnosrc.yml` 2 levels up from cwd (code in `src/server/`) → found.
- [ ] DISC-4: `.cnosrc.yml` 4+ levels up → NOT found. Error thrown.
- [ ] DISC-5: No `.cnosrc.yml` anywhere → clear error with actionable message.
- [ ] DISC-6: `.cnosrc.yml` with `root: ../../.cnos` → manifest found at resolved path.
- [ ] DISC-7: `.cnosrc.yml` with `root: ./.cnos` → self-contained project works.
- [ ] DISC-8: `.cnosrc.yml` points to nonexistent root → clear error.
- [ ] DISC-9: `createCnos({ root: "/explicit/path/.cnos" })` skips discovery entirely.
- [ ] DISC-10: Two packages in same monorepo with different `.cnosrc.yml` → each resolves independently.
- [ ] DISC-11: `cnos init` creates `.cnosrc.yml` alongside `.cnos/`.
- [ ] DISC-12: `cnos init --workspace travel --root ../../.cnos` creates `.cnosrc.yml` without `.cnos/`.

### 9.2 Server projection

- [ ] PROJ-1: `toServerProjection()` returns values with `value.` prefix stripped.
- [ ] PROJ-2: `secretRefs` contains refs, never plaintext.
- [ ] PROJ-3: No `meta.*` in `values`.
- [ ] PROJ-4: `publicKeys` lists promoted keys.
- [ ] PROJ-5: `configHash` is deterministic for same input.
- [ ] PROJ-6: `configHash` changes when values change.
- [ ] PROJ-7: `configHash` does NOT change when only secret refs change.

### 9.3 Build command

- [ ] BUILD-1: `cnos build server --to .cnos-server.json` writes valid JSON.
- [ ] BUILD-2: Server projection file contains no decrypted secrets.
- [ ] BUILD-3: `cnos build env --to .env.prod` writes valid dotenv format.
- [ ] BUILD-4: `cnos build env --format shell` writes `export KEY="value"` lines.
- [ ] BUILD-5: `cnos build env --format json` writes valid JSON.
- [ ] BUILD-6: `cnos build env --format yaml` writes valid YAML.
- [ ] BUILD-7: `cnos build env --format docker-env` writes unquoted KEY=value.
- [ ] BUILD-8: `cnos build public --framework vite` applies VITE_ prefix.
- [ ] BUILD-9: `cnos build public --framework next` applies NEXT_PUBLIC_ prefix.
- [ ] BUILD-10: Secret keys in env build → `****` placeholder.
- [ ] BUILD-11: `--with-provenance` writes separate file.

### 9.4 Auto-discovery

- [ ] AUTO-1: `__CNOS_PROJECTION__` env var → runtime bootstraps from it.
- [ ] AUTO-2: `.cnos-server.json` next to `.cnosrc.yml` → runtime finds it.
- [ ] AUTO-3: `.cnos-server.json` in cwd → runtime finds it.
- [ ] AUTO-4: No projection, no env var → falls back to full resolution via `.cnosrc.yml`.
- [ ] AUTO-5: `cnos.loadProjection("custom.json")` works for explicit path.
- [ ] AUTO-6: Priority: env var > file > full resolution.
- [ ] AUTO-7: `import cnos from "@kitsy/cnos"` → auto-discovers, no manual setup.

### 9.5 Secret hydration

- [ ] HYD-1: `eager` — all secrets hydrated during startup.
- [ ] HYD-2: `eager` — auth failure throws before app logic runs.
- [ ] HYD-3: `lazy` — secrets hydrated on first read per vault.
- [ ] HYD-4: `refreshing` — secrets refresh after TTL.
- [ ] HYD-5: `refreshSecrets()` forces immediate re-hydration.
- [ ] HYD-6: `refreshSecret("db.password")` refreshes single key.
- [ ] HYD-7: Refresh picks up rotated values.

### 9.6 Namespace security in projections

- [ ] SEC-P-1: Server projection includes `value.*` and `secret.*` refs.
- [ ] SEC-P-2: Browser projection excludes `secret.*` entirely.
- [ ] SEC-P-3: Browser projection includes only promoted `value.*`.
- [ ] SEC-P-4: Env projection includes only explicitly mapped keys.
- [ ] SEC-P-5: Future sensitive namespace → excluded from browser projection.

### 9.7 Detach

- [ ] DET-1: Creates standalone `.cnos/` at package root.
- [ ] DET-2: Updates `.cnosrc.yml` to `root: ./.cnos`.
- [ ] DET-3: Standalone manifest has no `workspaces` block.
- [ ] DET-4: `.detached` marker written with original root info.
- [ ] DET-5: After detach, runtime resolves from child `.cnos/`.
- [ ] DET-6: Parent changes don't affect detached child.
- [ ] DET-7: Refuses if `.cnos/` already exists (unless `--force`).
- [ ] DET-8: Detached package works in separate repo.

### 9.8 Attach

- [ ] ATT-1: Imports child config into parent workspace.
- [ ] ATT-2: Archives child `.cnos/` to `.cnos.detached.bak/`.
- [ ] ATT-3: Restores `.cnosrc.yml` to parent root + workspace.
- [ ] ATT-4: After attach, runtime resolves from parent.
- [ ] ATT-5: Fails if workspace exists (unless `--force`).
- [ ] ATT-6: Refuses without `.detached` marker.

### 9.9 Projection format correctness

- [ ] FMT-1: Dotenv: `KEY=value\n`, no comments, no blank lines.
- [ ] FMT-2: Dotenv: values with `=` sign → only first `=` is delimiter.
- [ ] FMT-3: Dotenv: values with newlines → properly escaped/quoted.
- [ ] FMT-4: Shell: `export KEY="value"\n`.
- [ ] FMT-5: JSON: valid JSON object.
- [ ] FMT-6: YAML: valid YAML map.
- [ ] FMT-7: Docker env: unquoted `KEY=value`, no `export`.
- [ ] FMT-8: TOML: valid TOML.
- [ ] FMT-9: All formats handle unicode values correctly.
- [ ] FMT-10: All formats handle empty string values.
- [ ] FMT-11: All formats handle boolean/number values (coerced to string).

### 9.10 Integration

- [ ] INT-1: Monorepo: two apps resolve different workspaces from same root.
- [ ] INT-2: `cnos build server` → Docker COPY → container starts from projection.
- [ ] INT-3: `cnos run` from monorepo child → correct workspace, correct values.
- [ ] INT-4: Detach → modify → attach → parent has updated config.
- [ ] INT-5: Server + browser projections produce consistent `publicKeys`.
- [ ] INT-6: `cnos build env` + `docker run --env-file` → app reads correct values.
- [ ] INT-7: `cnos build public --framework vite` → Vite build reads correct `import.meta.env`.
