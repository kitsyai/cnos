# CNOS v2 — Canonical Specification

**Project:** `@kitsy/cnos`
**Published packages:** `@kitsy/cnos`, `@kitsy/cnos-cli`, `@kitsy/cnos-vite`, `@kitsy/cnos-next`
**Status:** Implementation-ready v2 specification (supersedes v1)
**License intent:** Open source

---

## 1. What CNOS Is

CNOS is a **configuration resolution system**.

Named input streams ingest config from files, `.env`, shell env, CLI args, GitHub, Firebase, and any pluggable remote source. CNOS core merges those streams into one logical config graph, applies namespaces, resolves precedence and inheritance, and produces the final resolved config map. Named output surfaces then expose that graph appropriately: server runtime reads everything, browser runtime reads only promoted values, env export flattens to shell variables, framework plugins inject into `NEXT_PUBLIC_*` or `VITE_*` slots.

```
Named Input Streams → CNOS core (workspace, namespace, merge, resolve, validate) → Named Output Surfaces → Runtime modules
```

The invariant:

> **Application code reads logical keys. Streams decide where values come from. Surfaces decide what each consumer can see. CNOS orchestrates both.**

---

## 2. Why CNOS Exists

Same problems as v1 (source sprawl, precedence confusion, convention lock-in, value/secret/public leakage, poor debuggability, frontend/backend divergence, workspace ambiguity) plus:

9. **No unified model for remote config** — feature flags in Firebase, secrets in GitHub, values on disk all use separate ad hoc integrations.
10. **Browser/server boundary is implicit** — what the browser can see is determined by framework convention, not by explicit declaration.
11. **Config sources lack lifecycle awareness** — some sources are static (files), some are refreshable (Firebase flags), some are CI-only (GitHub secrets). No tool models these differences declaratively.

---

## 3. Product Thesis

> **Write code against config keys, not config sources. Streams bring config in. Surfaces control what goes out.**

---

## 4. Design Principles

1. **Stable logical key access** — app code reads keys.
2. **Workspace-first resolution** — one active workspace per invocation.
3. **Local manifest authority** — `.cnos/cnos.yml` is authoritative.
4. **Stream-based input** — every config source is a named stream with lifecycle and enablement rules.
5. **Surface-based output** — every consumer is a named surface with namespace filtering and security boundaries.
6. **Custom namespaces** — teams can define `flag.*`, `remote.*`, or any domain-specific namespace.
7. **Multi-runtime** — server, browser, and SSR have distinct runtime modules with different visibility.
8. **Plugin-based growth** — loaders, resolvers, exporters, validators, inspectors, and bundler plugins are all pluggable.
9. **Provenance-first debugging** — every resolved key traces back to stream, workspace, profile, and file.
10. **Secret enforcement** — `secret.*` and sensitive custom namespaces never leak to public surfaces.
11. **Simple-first adoption** — a single-project app with `.env` needs zero stream/surface config.

---

## 5. Core Mental Model

### 5.1 Namespaces

Built-in namespaces (always present, not redefinable):

| Namespace | Purpose | Example key |
|-----------|---------|-------------|
| `value.*` | Non-secret config | `value.server.port` |
| `secret.*` | Sensitive config | `secret.db.password` |
| `meta.*` | Resolution metadata (read-only) | `meta.workspace`, `meta.streams.active` |

Custom namespaces (user-defined in manifest):

| Namespace | Example use | Example key |
|-----------|-------------|-------------|
| `flag.*` | Feature flags from Firebase | `flag.dark-mode.enabled` |
| `remote.*` | Remote-synced config | `remote.api.rateLimit` |

### 5.2 Public as Promotion

Unchanged from v1. `public` is not a namespace. It is a promotion mechanism for `value.*` keys and promotable custom namespace keys. `secret.*` and any namespace marked `sensitive: true` can never be promoted.

### 5.3 Meta Keys

| Key | Value | Source |
|-----|-------|--------|
| `meta.profile` | Active profile | Profile resolver |
| `meta.profile.source` | How profile was selected | Profile resolver |
| `meta.workspace` | Active workspace ID | Workspace resolver |
| `meta.workspace.source` | How workspace was selected | Workspace resolver |
| `meta.workspace.chain` | Workspace chain (parents first) | Workspace resolver |
| `meta.global.root` | Global root path if active | Workspace resolver |
| `meta.global.enabled` | Whether global is active | Workspace resolver |
| `meta.cnos.version` | Runtime version | Core |
| `meta.resolved.at` | Resolution timestamp | Core |
| `meta.streams.active` | Active stream IDs (JSON array) | Core |
| `meta.stream.<id>.version` | Version pin for remote stream | Stream resolver |
| `meta.stream.<id>.refreshedAt` | Last refresh timestamp | Stream resolver |

---

## 6. Workspace Model

**Unchanged from v1.** See v1 spec §6. All workspace rules, selection precedence, global root policy, `.cnos-workspace.yml`, WorkspaceContext, effective root ordering, and write behavior carry forward without modification.

---

## 7. Named Input Streams

### 7.1 What a Stream Is

A stream is a named group of one or more loaders with shared configuration, enablement rules, and lifecycle. Streams replace the flat `plugins.loaders` list from v1.

### 7.2 Manifest Shape

```yaml
streams:
  # Local filesystem — the default
  local:
    loaders:
      - filesystem-values
      - filesystem-secrets
      - dotenv
    enabled: always
    default: true              # auto-initializes for singleton access

  # Shell/CLI — always active
  env:
    loaders:
      - process-env
      - cli-args
    enabled: always

  # GitHub secrets — CI only
  github:
    loader: github-secrets
    config:
      token: ${GITHUB_TOKEN}
      repo: myorg/config
      ref: v2.3.1             # version pin
    enabled:
      when: env.CI == "true"

  # Firebase feature flags
  firebase:
    loader: firebase-remote-config
    config:
      projectId: my-project
    namespace: flag            # entries land in flag.* namespace
    enabled: always
    refresh:
      strategy: lazy           # lazy | eager | manual
      ttl: 300
```

### 7.3 Stream Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `loaders` | string[] | yes (or `loader`) | Loader plugin IDs |
| `loader` | string | yes (or `loaders`) | Single loader shorthand |
| `config` | object | no | Loader-specific config passed in context |
| `enabled` | `"always"` \| `{ when: string }` | yes | Enablement rule |
| `default` | boolean | no | If true, stream auto-resolves for singleton |
| `namespace` | string | no | Force all entries into this namespace |
| `refresh` | object | no | Remote refresh config |
| `refresh.strategy` | `"lazy"` \| `"eager"` \| `"manual"` | no | When to refresh |
| `refresh.ttl` | number | no | Seconds before refresh |

### 7.4 Enablement Rules

- `enabled: always` — stream is always active.
- `enabled: { when: "env.CI == true" }` — conditional on environment.
- Enablement is evaluated at resolution time, not at manifest parse time.

### 7.5 Default Stream

When a stream has `default: true`, the `@kitsy/cnos` module can auto-resolve without explicit `createCnos()`. The default stream must be one whose loaders can resolve from the local filesystem without additional configuration.

### 7.6 Backward Compatibility

If the manifest uses the v1 `plugins.loaders` format instead of `streams`, CNOS treats it as a single implicit stream named `default` containing all listed loaders. This is a migration path, not a permanent dual format.

---

## 8. Named Output Surfaces

### 8.1 What a Surface Is

A surface is a named output projection of the resolved graph. Each surface declares which namespaces it exposes and what filtering applies. Surfaces make the security boundary between server and browser **explicit and auditable**.

### 8.2 Manifest Shape

```yaml
surfaces:
  server:
    namespaces: [value, secret, meta, flag]
    runtime: "@kitsy/cnos"

  browser:
    namespaces: [value, flag]
    filter: public.promote
    runtime: "@kitsy/cnos/browser"

  env:
    type: env-export
    namespaces: [value, secret]
    filter: envMapping.explicit

  public:
    type: env-export
    namespaces: [value]
    filter: public.promote
    frameworks:
      next: NEXT_PUBLIC_
      vite: VITE_
      nuxt: NUXT_PUBLIC_
```

### 8.3 Surface Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `namespaces` | string[] | yes | Which namespaces are visible |
| `filter` | string | no | Filter rule: `"public.promote"` or `"envMapping.explicit"` |
| `runtime` | string | no | Import path for runtime module |
| `type` | string | no | `"env-export"` for env flattening surfaces |
| `frameworks` | object | no | Framework prefix mappings |

### 8.4 Implicit Surfaces

If no `surfaces` block is defined, CNOS creates implicit surfaces matching v1 behavior:

- `server` → all namespaces.
- `env` → explicit env mappings.
- `public` → promoted values with framework prefixes.

### 8.5 Surface Access

```ts
// Full runtime (server)
const cnos = await createCnos();
cnos.read("value.server.port");       // works
cnos.read("secret.db.password");      // works
cnos.read("flag.dark-mode.enabled");  // works

// Surface view
const browser = cnos.surface("browser");
browser.read("value.api.baseUrl");    // works (promoted)
browser.read("secret.db.password");   // throws: not available on this surface
browser.read("flag.dark-mode.enabled"); // works (flag is in browser surface)
```

---

## 9. Custom Namespaces

### 9.1 Definition

```yaml
namespaces:
  custom:
    flag:
      source: firebase           # which stream populates this
      promotable: true           # can be promoted to public/browser
      sensitive: false           # if true, never promotable
    remote:
      source: github
      promotable: false
      sensitive: false
    experiment:
      source: local
      promotable: true
      sensitive: false
```

### 9.2 Rules

- Built-in namespaces (`value`, `secret`, `meta`) are always present and not redefinable.
- Custom namespaces are declared in the manifest.
- A namespace with `sensitive: true` behaves like `secret.*` — never promotable, never on browser surface.
- `source` maps to a stream ID. If a loader from a different stream produces entries for this namespace, it is an error unless the stream declares `namespace: <n>`.
- Custom namespace keys follow the same `<namespace>.<path>` pattern: `flag.dark-mode.enabled`.

### 9.3 Impact on NamespaceName

```ts
// No longer a fixed union — validated against manifest + builtins
type NamespaceName = string;
const BUILTIN_NAMESPACES: readonly string[] = ["value", "secret", "meta"];
```

---

## 10. Multi-Runtime

### 10.1 Server Runtime: `@kitsy/cnos`

Unchanged from v1 as the primary entry point. Full access to all namespaces.

**New: singleton access.**

```ts
// Explicit (unchanged)
import { createCnos } from "@kitsy/cnos";
const cnos = await createCnos({ workspace: "api" });

// Singleton (new — requires default stream)
import cnos from "@kitsy/cnos";
await cnos.ready();
cnos.read("value.server.port");
```

`cnos.ready()` lazily resolves the default stream. If no default stream is declared, `cnos.ready()` throws with a clear message.

### 10.2 Browser Runtime: `@kitsy/cnos/browser`

A lightweight runtime for browser/client code.

```ts
import cnos from "@kitsy/cnos/browser";

cnos.read("value.api.baseUrl");         // works (promoted)
cnos.read("flag.dark-mode.enabled");    // works (promotable + promoted)
cnos.read("secret.db.password");        // throws: not available
```

**How the browser runtime gets its data:**

1. At build time, the bundler plugin (`@kitsy/cnos-vite`, `@kitsy/cnos-next`) resolves the `browser` surface.
2. The resolved key-value pairs are injected into the bundle as a static JSON blob or as framework-specific env vars.
3. At runtime, `@kitsy/cnos/browser` reads from that injected data.
4. Optionally, the browser runtime connects to remote refresh sources (e.g., Firebase for `flag.*` with lazy/eager refresh).

**Security invariant:** The browser runtime can only access keys that passed through the `browser` surface's namespace + filter rules at build time. There is no runtime bypass.

### 10.3 Bundler Plugin Contract

```ts
interface CnosBundlerPlugin {
  name: string;
  framework: string;
  resolve(options: BundlerPluginOptions): Promise<Record<string, string>>;
}

interface BundlerPluginOptions {
  cnosRoot?: string;
  workspace?: string;
  profile?: string;
  surface?: string;      // default: "browser"
}
```

| Framework | Injection target |
|-----------|-----------------|
| Vite | `import.meta.env.VITE_*` |
| Next.js | `process.env.NEXT_PUBLIC_*` |
| Webpack | `process.env.*` via DefinePlugin |
| Generic | `globalThis.__CNOS_PUBLIC__` |

`@kitsy/cnos-vite` and `@kitsy/cnos-next` are refactored to use this contract. New: `@kitsy/cnos-webpack` (deferred implementation, but contract is ready).

---

## 11. Architecture

### 11.1 Pipeline

```
┌────────────────────┐    ┌───────────────────────────────────────┐    ┌──────────────────────┐
│  NAMED INPUT       │    │         CNOS CORE                      │    │  NAMED OUTPUT        │
│  STREAMS           │    │                                       │    │  SURFACES            │
│                    │    │  1. resolve workspace                  │    │                      │
│  local (fs/dotenv) │───▶│  2. evaluate stream enablement         │───▶│  server (full graph) │
│  env (process/cli) │    │  3. load from enabled streams          │    │  browser (promoted)  │
│  github (ci-only)  │    │  4. assign namespaces                  │    │  env (explicit map)  │
│  firebase (flags)  │    │  5. resolve profiles                   │    │  public (frameworks) │
│  custom (X)        │    │  6. merge with precedence              │    │  dump (filesystem)   │
│                    │    │  7. validate                           │    │  cli (inspect/read)  │
└────────────────────┘    │  8. produce ResolvedGraph              │    └──────────────────────┘
                          └───────────────────────────────────────┘
```

### 11.2 Package Structure

```
packages/
  cnos/           → core engine + server runtime + browser runtime
  cli/            → CLI commands
  vite/           → Vite bundler plugin
  next/           → Next.js bundler plugin
```

- `@kitsy/cnos` — core engine, `createCnos()`, server runtime, `@kitsy/cnos/browser` subpath export
- `@kitsy/cnos-cli` — CLI
- `@kitsy/cnos-vite` — Vite plugin using bundler contract
- `@kitsy/cnos-next` — Next.js plugin using bundler contract

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
  streamId: string;         // which stream produced this
  workspaceId: string;
  profile?: string;
  origin?: {
    file?: string;
    line?: number;
    envVar?: string;
    cliArg?: string;
  };
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
```

### 12.2 Plugin Contracts

Unchanged from v1, plus:

```ts
interface LoaderContext {
  manifestConfig: Record<string, unknown>;
  profile: string;
  profileChain: string[];
  manifestRoot: string;
  workspace: WorkspaceContext;
  streamId: string;
  streamConfig: Record<string, unknown>;
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
}
```

### 12.3 Surface View

```ts
interface SurfaceView {
  readonly name: string;
  readonly namespaces: NamespaceName[];
  read<T = unknown>(key: LogicalKey): T | undefined;
  require<T = unknown>(key: LogicalKey): T;
  readOr<T>(key: LogicalKey, fallback: T): T;
  toObject(): Record<string, unknown>;
  toEnv(): Record<string, string>;
}
```

### 12.4 Runtime

```ts
interface CnosRuntime {
  // Core reads (unchanged)
  read<T = unknown>(key: LogicalKey): T | undefined;
  require<T = unknown>(key: LogicalKey): T;
  readOr<T>(key: LogicalKey, fallback: T): T;
  value<T = unknown>(path: string): T | undefined;
  secret<T = unknown>(path: string): T | undefined;
  meta<T = unknown>(path: string): T | undefined;

  // Inspection (unchanged)
  inspect(key: LogicalKey): InspectResult;

  // Projection (unchanged)
  toObject(): Record<string, unknown>;
  toNamespace(namespace: NamespaceName): Record<string, unknown>;
  toEnv(options?: ToEnvOptions): Record<string, string>;
  toPublicEnv(options?: ToPublicEnvOptions): Record<string, string>;

  // NEW: surface access
  surface(name: string): SurfaceView;

  // Graph access
  readonly graph: ResolvedGraph;
  readonly workspace: WorkspaceContext;

  // NEW: lifecycle
  ready(): Promise<void>;
}
```

---

## 13–20. Unchanged From v1

The following sections carry forward from the v1 spec without modification:

- **§13 Resolution** — same resolver, same precedence model. Precedence now references stream IDs.
- **§14 Validation** — same rules, extended: custom namespace `sensitive` flag validated.
- **§15 Inspection/Provenance** — same, with `streamId` added to winner/overridden entries.
- **§16 Export/Projection/Dump** — same. `toEnv()` and `toPublicEnv()` are now backed by named surfaces.
- **§17 Env Mapping** — unchanged.
- **§18 Runtime API** — extended per §12.4. Constructor gains no new required fields.
- **§19 CLI** — unchanged. Future: `cnos list streams`, `cnos list surfaces`.
- **§20 Write Policy** — unchanged.

---

## 21. Internal Module Layout

```
packages/cnos/src/
  index.ts                    # createCnos, singleton, re-exports
  browser/
    index.ts                  # browser runtime entry (@kitsy/cnos/browser)
    embed.ts                  # reads injected build-time data
    refresh.ts                # optional remote refresh (firebase etc)
  types/
    core.ts
    plugin.ts
    manifest.ts
    workspace.ts
    profile.ts
    schema.ts
    export.ts
    stream.ts                 # NEW: stream types
    surface.ts                # NEW: surface types
    namespace.ts              # NEW: custom namespace types
  manifest/
    loadManifest.ts
    normalizeManifest.ts
    loadWorkspaceFile.ts
  streams/                    # NEW
    resolveStreams.ts          # evaluate enablement, produce active stream list
    streamRegistry.ts         # map stream IDs to loader configs
  surfaces/                   # NEW
    resolveSurfaces.ts        # parse surface definitions
    surfaceView.ts            # SurfaceView implementation
    filterGraph.ts            # namespace + promotion filtering
  workspaces/
    resolveWorkspaceContext.ts
    expandWorkspaceChain.ts
  profiles/
    resolveActiveProfile.ts
    expandProfileChain.ts
  orchestrator/
    createCnos.ts
    singleton.ts              # NEW: default stream singleton
    runtime.ts
    pipeline.ts               # workspace → streams → load → resolve → validate → surfaces → ready
  loaders/
    filesystemValues.ts
    filesystemSecrets.ts
    dotenv.ts
    processEnv.ts
    cliArgs.ts
  resolvers/
    profileAwareResolver.ts
  validators/
    basicSchema.ts
    publicSafety.ts
    workspaceSafety.ts
    namespaceSafety.ts        # NEW: custom namespace validation
  exporters/
    toEnv.ts
    toPublicEnv.ts
    dump.ts
  inspectors/
    provenance.ts
  utils/
    path.ts, flatten.ts, deepMerge.ts, yaml.ts, envNaming.ts

packages/cli/src/
  commands/
    init.ts, read.ts, define.ts, inspect.ts, validate.ts,
    export.ts, run.ts, diff.ts, dump.ts, doctor.ts,
    list.ts, use.ts, secret.ts, profile.ts, help.ts

packages/vite/src/
  index.ts                    # implements CnosBundlerPlugin for Vite

packages/next/src/
  index.ts                    # implements CnosBundlerPlugin for Next.js
```

---

## 22. Testing Requirements

All v1 tests carry forward. Additional v2 tests:

### Stream tests
- Stream enablement: `always`, conditional `when`.
- Disabled stream produces no entries.
- Stream precedence ordering.
- Stream-specific namespace assignment.
- Default stream auto-initialization.
- `meta.streams.active` populated correctly.
- Remote stream version pin in meta.

### Surface tests
- Server surface sees all namespaces.
- Browser surface sees only promoted + promotable.
- `secret.*` never on browser surface.
- Custom sensitive namespace never on browser surface.
- `cnos.surface("browser").read("secret.*")` → throws.
- Surface with `filter: public.promote` returns only promoted keys.
- Implicit surfaces when no `surfaces` block defined.

### Custom namespace tests
- Custom namespace keys resolve correctly.
- `flag.*` keys from Firebase stream land in `flag` namespace.
- Promotable custom namespace keys appear in public export.
- Sensitive custom namespace keys blocked from promotion.

### Browser runtime tests
- Browser runtime reads embedded data.
- Browser runtime rejects `secret.*` reads.
- Browser runtime rejects non-promoted `value.*` reads.

### Bundler plugin tests
- Vite plugin resolves browser surface.
- Next plugin resolves browser surface.
- Framework prefix mapping applied correctly.

---

## 23. Scope

### In v2
- Named input streams with enablement and lifecycle.
- Named output surfaces with namespace filtering.
- Custom namespace definitions.
- Browser runtime module.
- Singleton/default stream pattern.
- Bundler plugin contract.
- Remote stream version pinning (manifest shape, not implementation).
- Stream and surface meta keys.
- `@kitsy/cnos/browser` subpath export.
- Refactored Vite/Next plugins using bundler contract.

### Deferred beyond v2
- Remote loader implementations (GitHub secrets, Firebase remote config).
- `@kitsy/cnos-webpack`.
- Hosted CNOS server.
- Live sync/watch.
- OS keychain integration.
- Cross-stream conflict warnings.
- `cnos list streams` / `cnos list surfaces` CLI commands.

---

## 24. Hard Constraints

All v1 constraints carry forward, plus:

10. Browser runtime must never have access to `secret.*` or sensitive custom namespaces.
11. Surface definitions are the sole authority for what each consumer can see.
12. Streams must be explicitly enabled — no silent activation.
13. Custom namespaces must be declared in the manifest — undeclared namespace prefixes are errors.
14. The `default` stream must resolve from local filesystem only — no remote default stream.

---

## 25. Delivery Plan

### Phase 1: Streams + Surfaces (on top of shipped v1)

- Stream manifest parsing and normalization.
- Stream enablement evaluation.
- Stream-aware loader dispatch.
- `ConfigEntry.streamId` and `LoaderContext.streamId`.
- Surface manifest parsing.
- `SurfaceView` implementation.
- `cnos.surface("browser")` on server runtime.
- Implicit surfaces for backward compat.
- `meta.streams.active`.
- Backward compat: `plugins.loaders` → implicit default stream.

### Phase 2: Custom Namespaces + Browser Runtime

- Custom namespace definition parsing.
- `NamespaceName` validation against builtins + custom.
- Sensitive namespace enforcement.
- `@kitsy/cnos/browser` module.
- Build-time data embedding.
- Browser-side promoted-only read.

### Phase 3: Singleton + Bundler Contract

- Default stream auto-initialization.
- Singleton export from `@kitsy/cnos`.
- `cnos.ready()`.
- `CnosBundlerPlugin` contract.
- Refactor `@kitsy/cnos-vite` to use contract.
- Refactor `@kitsy/cnos-next` to use contract.

### Phase 4: Remote Stream Contracts

- Remote stream version pinning.
- Refresh strategy manifest parsing.
- `meta.stream.<id>.version` and `meta.stream.<id>.refreshedAt`.
- Loader plugin contract for remote sources (interface only, no implementations).
- Browser-side lazy refresh for remote namespaces.

### Phase 5: Tests + Docs

- Full v2 test suite.
- Updated README.
- Updated how-to guide.
- Migration guide from v1 manifest to v2.
