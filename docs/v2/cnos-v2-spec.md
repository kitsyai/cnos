# CNOS v2 — Canonical Specification

**Project:** `@kitsy/cnos`
**Packages:** `@kitsy/cnos`, `@kitsy/cnos-cli`, `@kitsy/cnos-vite`, `@kitsy/cnos-next`
**Status:** Architecture reference for v2 (supersedes v1 spec after v1 enters maintenance)
**License intent:** Open source

---

## 1. What CNOS Is

CNOS is a **configuration resolution system**.

Named input streams ingest config from files, `.env`, shell env, CLI args, and pluggable remote sources. CNOS core merges those streams into one logical config graph, applies namespaces, resolves precedence and inheritance, and produces the final resolved config map. Named output surfaces expose that graph appropriately: server runtime reads everything, browser runtime reads only promoted values, env export flattens to shell variables, framework plugins inject into `NEXT_PUBLIC_*` or `VITE_*` slots.

```
Named Input Streams → CNOS core (workspace, namespace, merge, resolve, validate) → Named Output Surfaces → Runtime modules
```

> **Application code reads logical keys. Streams decide where values come from. Surfaces decide what each consumer can see.**

---

## 2. Why CNOS Exists

1. Source sprawl.
2. Unclear precedence.
3. Convention lock-in.
4. Weak value/secret/public separation.
5. Poor debuggability.
6. Frontend/backend divergence.
7. Scaling friction.
8. Workspace ambiguity in monorepos.
9. No unified model for remote config and feature flags.
10. Browser/server boundary is implicit and unauditable.

---

## 3. Product Thesis

> **Write code against config keys, not config sources. Streams bring config in. Surfaces control what goes out.**

---

## 4. Design Principles

1. **Stable logical key access.**
2. **Workspace-first resolution.**
3. **Local manifest authority.**
4. **Stream-based input** — every config source is a named stream.
5. **Surface-based output** — every consumer is a named surface.
6. **Custom namespaces** — `flag.*`, `remote.*`, or any domain-specific namespace.
7. **Multi-runtime** — server, browser, and SSR have distinct visibility.
8. **CLI-first adoption** — `cnos run` works with zero code changes; programmatic access is opt-in depth.
9. **Plugin-based growth.**
10. **Provenance-first debugging.**
11. **Secret enforcement** — `secret.*` and sensitive namespaces never reach public surfaces.
12. **Simple-first** — a solo developer uses CNOS in under 10 minutes with sensible defaults.

---

## 5. Core Mental Model

### 5.1 Namespaces

Built-in (always present):

| Namespace | Purpose |
|-----------|---------|
| `value.*` | Non-secret config |
| `secret.*` | Sensitive config |
| `meta.*` | Resolution metadata (read-only) |

Custom (declared in manifest when needed):

| Namespace | Example use |
|-----------|-------------|
| `flag.*` | Feature flags from Firebase |
| `remote.*` | Remote-synced config |

### 5.2 Public as Promotion

Unchanged from v1. `public` is not a namespace — it is a promotion mechanism. `secret.*` and `sensitive: true` namespaces can never be promoted.

### 5.3 Meta Keys

All v1 meta keys carry forward. v2 adds:

| Key | Value |
|-----|-------|
| `meta.streams.active` | Active stream IDs |
| `meta.stream.<id>.version` | Version pin for remote stream |
| `meta.stream.<id>.refreshedAt` | Last refresh timestamp |

---

## 6. Workspace Model

**Unchanged from v1.** All workspace rules, selection precedence, global root policy, `.cnos-workspace.yml`, WorkspaceContext, effective root ordering, and write behavior carry forward.

---

## 7. Manifest

### 7.1 Format

v2 supports two manifest formats. CNOS checks for `config.ts` first, then `cnos.yml`. Only one is authoritative.

#### YAML: `.cnos/cnos.yml`

```yaml
version: 2

project:
  name: my-service

workspaces:
  default: api
  global:
    enabled: true
    root: ~/.cnos
    allowWrite: true
  items:
    base: {}
    api:
      extends: [base]
      globalId: api

profiles:
  default: local
  resolveFrom: [cli.profile, env.CNOS_PROFILE, default]

config:
  precedence: [local, github, firebase, env]
  arrayPolicy: replace
  streams:
    local:
      loaders: [filesystem-values, filesystem-secrets, dotenv]
      enabled: always
      default: true
    github:
      loader: github-secrets
      token: ${GITHUB_TOKEN}
      ref: v2.3.1
      enabled: { when: CI }
    firebase:
      loader: firebase-remote-config
      projectId: my-project
      namespace: flag
      refresh: { strategy: lazy, ttl: 300 }
    env:
      loaders: [process-env, cli-args]
      enabled: always
  write:
    defaultProfile: local
    targets:
      value: ./values/{profile}/app.yml
      secret: ./secrets/{profile}/app.yml

env:
  convention: SCREAMING_SNAKE
  export:
    DATABASE_HOST: value.db.host
    DATABASE_PASSWORD: secret.db.password

public:
  promote: [value.api.baseUrl, value.app.name, flag.dark-mode.enabled]
  frameworks:
    next: NEXT_PUBLIC_
    vite: VITE_
    nuxt: NUXT_PUBLIC_

namespaces:
  flag:
    source: firebase
    promotable: true
    sensitive: false

surfaces:
  server:
    namespaces: [value, secret, meta, flag]
  browser:
    namespaces: [value, flag]
    filter: public.promote

schema:
  value.server.port: { type: number, required: true }
  value.api.baseUrl: { type: string, required: true }
  secret.db.password: { type: string, required: true }
```

#### TypeScript: `.cnos/config.ts`

```ts
import { defineConfig } from "@kitsy/cnos";

export default defineConfig({
  version: 2,
  project: { name: "my-service" },
  profiles: { default: "local" },
  config: {
    precedence: ["local", "env"],
    streams: {
      local: { loaders: ["filesystem-values", "filesystem-secrets", "dotenv"], enabled: "always", default: true },
      env: { loaders: ["process-env", "cli-args"], enabled: "always" },
    },
  },
  env: { convention: "SCREAMING_SNAKE" },
  public: { promote: ["value.api.baseUrl"], frameworks: { vite: "VITE_" } },
  schema: { "value.server.port": { type: "number", required: true } },
});
```

### 7.2 Minimal manifest (simple project)

```yaml
version: 2
project:
  name: my-service

schema:
  value.server.port: { type: number, required: true }
```

Everything else uses defaults. `config.precedence` defaults to `[files, dotenv, env, cli]`. No streams/surfaces/namespaces needed. This is the 10-minute adoption path.

### 7.3 Section reference

| Section | Purpose | Required |
|---------|---------|----------|
| `project` | Name and metadata | Yes |
| `workspaces` | Multi-app isolation | No (implicit single-workspace) |
| `profiles` | Environment selection | No (defaults to `local`) |
| `config` | Loaders, precedence, streams, write policy | No (sensible defaults) |
| `env` | Env var mapping and export | No |
| `public` | Browser-safe promotion | No |
| `namespaces` | Custom namespace definitions | No |
| `surfaces` | Output projections | No (implicit server/browser/env/public) |
| `schema` | Type and requirement rules | No (but recommended) |

---

## 8. Named Input Streams

### 8.1 What a Stream Is

A stream is a named group of one or more loaders with shared configuration and enablement rules.

### 8.2 Properties

| Property | Type | Description |
|----------|------|-------------|
| `loaders` / `loader` | string[] / string | Loader plugin IDs |
| `config` / inline keys | object | Loader-specific config |
| `enabled` | `"always"` \| `{ when: ENV_VAR }` | Enablement rule |
| `default` | boolean | Auto-resolves for singleton |
| `namespace` | string | Force entries into this namespace |
| `refresh` | `{ strategy, ttl }` | Remote refresh config |
| `ref` / `version` | string | Version pin for remote sources |

### 8.3 Defaults

If no `streams` in manifest, CNOS creates:
- `files` → `[filesystem-values, filesystem-secrets, dotenv]`, enabled always, default true
- `env` → `[process-env, cli-args]`, enabled always

### 8.4 Precedence

`config.precedence` references stream IDs. Within a stream, loaders run in declaration order.

---

## 9. Named Output Surfaces

### 9.1 What a Surface Is

A surface is a named output projection with namespace filtering and security boundaries.

### 9.2 Properties

| Property | Type | Description |
|----------|------|-------------|
| `namespaces` | string[] | Visible namespaces |
| `filter` | string | `"public.promote"` or `"env.export"` |
| `runtime` | string | Import path hint |
| `frameworks` | object | Prefix mappings (for env-export surfaces) |

### 9.3 Defaults

If no `surfaces` in manifest:
- `server` → all namespaces
- `browser` → `[value]`, filter `public.promote`
- `env` → `[value, secret]`, filter `env.export`
- `public` → `[value]`, filter `public.promote`, framework prefixes from `public.frameworks`

### 9.4 Runtime access

```ts
const cnos = await createCnos();
cnos.read("value.server.port");           // server: full access
const browser = cnos.surface("browser");
browser.read("value.api.baseUrl");        // browser: promoted only
browser.read("secret.db.password");       // throws
```

---

## 10. Custom Namespaces

Declared in manifest. Tied to source streams.

```yaml
namespaces:
  flag:
    source: firebase
    promotable: true
    sensitive: false
```

Rules: built-ins always present, `sensitive: true` = never promotable, undeclared prefixes = error.

---

## 11. Multi-Runtime

### 11.1 Server: `@kitsy/cnos`

Full access. Supports `createCnos()` (explicit) and `import cnos from "@kitsy/cnos"` (singleton with `cnos.ready()`).

### 11.2 Browser: `@kitsy/cnos/browser`

Lightweight. Reads from build-time embedded data. Throws on `secret.*` and non-promoted keys. Optional lazy refresh for remote namespaces.

### 11.3 Bundler Plugin Contract

```ts
interface CnosBundlerPlugin {
  name: string;
  framework: string;
  resolve(options: BundlerPluginOptions): Promise<Record<string, string>>;
}
```

Vite, Next, and future Webpack plugins all implement this contract. They resolve the `browser` surface at build time and inject the result.

---

## 12. Core Domain Model

### 12.1 Types

```ts
type LogicalKey = string;
type NamespaceName = string;  // validated against builtins + custom
const BUILTIN_NAMESPACES = ["value", "secret", "meta"] as const;

interface ConfigEntry {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  sourceId: string;
  pluginId: string;
  streamId: string;
  workspaceId: string;
  profile?: string;
  origin?: { file?: string; line?: number; envVar?: string; cliArg?: string };
  metadata?: Record<string, unknown>;
}

interface ResolvedEntry {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  winner: ConfigEntry;
  overridden: ConfigEntry[];
}

interface ResolvedGraph {
  entries: Map<LogicalKey, ResolvedEntry>;
  profile: string;
  resolvedAt: string;
  profileSource: string;
  workspace: WorkspaceContext;
  activeStreams: string[];
}

interface SurfaceView {
  readonly name: string;
  readonly namespaces: NamespaceName[];
  read<T = unknown>(key: LogicalKey): T | undefined;
  require<T = unknown>(key: LogicalKey): T;
  readOr<T>(key: LogicalKey, fallback: T): T;
  toObject(): Record<string, unknown>;
  toEnv(): Record<string, string>;
}

interface CnosRuntime {
  read<T = unknown>(key: LogicalKey): T | undefined;
  require<T = unknown>(key: LogicalKey): T;
  readOr<T>(key: LogicalKey, fallback: T): T;
  value<T = unknown>(path: string): T | undefined;
  secret<T = unknown>(path: string): T | undefined;
  meta<T = unknown>(path: string): T | undefined;
  inspect(key: LogicalKey): InspectResult;
  toObject(): Record<string, unknown>;
  toNamespace(namespace: NamespaceName): Record<string, unknown>;
  toEnv(options?: ToEnvOptions): Record<string, string>;
  toPublicEnv(options?: ToPublicEnvOptions): Record<string, string>;
  surface(name: string): SurfaceView;
  readonly graph: ResolvedGraph;
  readonly workspace: WorkspaceContext;
  ready(): Promise<void>;
}
```

---

## 13–17. Carried Forward From v1

Resolution (single `profile-aware` resolver, workspace-first), validation, inspection/provenance (with `streamId`), export/projection/dump, env mapping — all carry forward. Precedence now references stream IDs.

---

## 18. CLI

All v1 CLI commands carry forward. v2 additions:

- `cnos codegen` — type generation (implemented in v1 already).
- `cnos watch` — dev reload (implemented in v1 already).
- `cnos migrate` — adoption scanner (implemented in v1 already).
- `cnos drift` — schema vs config comparison (implemented in v1 already).
- Future: `cnos list streams`, `cnos list surfaces`.

---

## 19. Internal Module Layout

```
packages/cnos/src/
  index.ts
  browser/
    index.ts, embed.ts, refresh.ts
  build/
    index.ts                          # resolveBrowserData for bundler plugins
  types/
    core.ts, plugin.ts, manifest.ts, workspace.ts, profile.ts,
    schema.ts, export.ts, stream.ts, surface.ts, namespace.ts
  manifest/
    loadManifest.ts, loadConfigTs.ts, normalizeManifest.ts, loadWorkspaceFile.ts
  streams/
    resolveStreams.ts, streamRegistry.ts
  surfaces/
    resolveSurfaces.ts, surfaceView.ts, filterGraph.ts
  workspaces/
    resolveWorkspaceContext.ts, expandWorkspaceChain.ts
  profiles/
    resolveActiveProfile.ts, expandProfileChain.ts
  orchestrator/
    createCnos.ts, singleton.ts, runtime.ts, pipeline.ts
  loaders/
    filesystemValues.ts, filesystemSecrets.ts, dotenv.ts, processEnv.ts, cliArgs.ts
  resolvers/
    profileAwareResolver.ts
  validators/
    basicSchema.ts, publicSafety.ts, workspaceSafety.ts, namespaceSafety.ts
  exporters/
    toEnv.ts, toPublicEnv.ts, dump.ts
  inspectors/
    provenance.ts
  codegen/
    generateTypes.ts, writeOutput.ts, watchSchema.ts
  migrate/
    scanEnvUsage.ts, proposeMapping.ts, applyManifest.ts
  drift/
    compareSchemaToGraph.ts
  watch/
    watchFiles.ts, diffGraphs.ts
  utils/
    path.ts, flatten.ts, deepMerge.ts, yaml.ts, envNaming.ts
```

---

## 20. Scope

### In v2

- Simplified manifest (7 sections from 12).
- `config.ts` alternative to YAML.
- Named input streams (user-facing, with real loaders).
- Named output surfaces (user-facing).
- Custom namespace definitions.
- Browser runtime (`@kitsy/cnos/browser`).
- Singleton runtime.
- Bundler plugin contract.
- All v1 features (codegen, watch, migrate, drift, browser).

### Deferred beyond v2

- Remote loader implementations (GitHub, Firebase) — contracts defined, implementations are separate plugins.
- `@kitsy/cnos-webpack`.
- Hosted CNOS server.
- Live sync/watch on remote streams.
- OS keychain integration.

---

## 21. Hard Constraints

All v1 constraints, plus:

10. Browser runtime must never access `secret.*` or sensitive namespaces.
11. Surfaces are the sole authority for consumer visibility.
12. Streams must be explicitly enabled.
13. Custom namespaces must be declared.
14. Default stream must use local filesystem loaders only.
15. v1 manifests (version 1) must work with a compat layer.

---

## 22. Delivery Plan

### Phase 1: Manifest v2 + config.ts

- New manifest parser (version 2 format).
- `config.ts` loader using dynamic import.
- `defineConfig()` type-safe helper.
- v1 manifest compat layer (version 1 → normalize to v2 internal shape).
- Simplified section structure.

### Phase 2: User-Facing Streams

- Stream parsing from `config.streams`.
- Stream enablement evaluation.
- Stream-aware loader dispatch.
- Precedence by stream ID.
- Implicit streams for backward compat.
- `meta.streams.*` keys.

### Phase 3: User-Facing Surfaces + Custom Namespaces

- Surface parsing.
- `SurfaceView` with namespace + promotion filtering.
- `cnos.surface("browser")`.
- Custom namespace parsing and validation.
- Sensitive namespace enforcement.
- Implicit surfaces for backward compat.

### Phase 4: Bundler Contract + Remote Contracts

- `CnosBundlerPlugin` interface.
- Refactor Vite/Next plugins.
- Remote loader interface with `refresh()`.
- Remote stream version/ref.
- Browser-side refresh stub.

### Phase 5: Polish

- Full test suite.
- Migration guide (v1 → v2 manifest).
- Updated docs.
