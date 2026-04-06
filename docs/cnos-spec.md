# CNOS v1 — Canonical Specification (Workspace-Integrated)

**Project:** `@kitsy/cnos`  
**Published packages:** `@kitsy/cnos`, `@kitsy/cnos-cli`, `@kitsy/cnos-vite`, `@kitsy/cnos-next`  
**Status:** Implementation-ready v1 specification  
**License intent:** Open source

---

## 1. What CNOS Is

CNOS is a **configuration resolution system**.

It sits between configuration sources and application surfaces. On one side, loader plugins ingest config from files, `.env`, shell env, CLI args, and — in the future — remote stores, GitHub, secret providers, hosted Kitsy roots, and kube-like sources. In the middle, CNOS core collects everything into one logical config graph, applies namespaces, resolves precedence and inheritance, and produces the final resolved config map. On the other side, output surfaces consume that resolved map in the form they need: application code reads logical keys, frontends get public-safe config, CLI tools inspect and define values, dump/materialization writes snapshot config trees, and env exporters flatten the graph for downstream tooling.

The mental model:

```text
Sources → Loader plugins → CNOS core (workspace, namespace, resolve, validate) → Projections / Exports / Read APIs
```

The invariant:

> **Application code reads logical keys. CNOS decides where values come from and how they're resolved. Plugins extend both sides.**

---

## 2. Why CNOS Exists

Configuration gets scattered across `.env` files, shell variables, YAML files, CLI args, CI/CD injected vars, framework-specific public env conventions, and secret files. In monorepos and centralized-config workflows, another question appears: **which app/workspace is active right now?** CNOS ships first-party Vite and Next.js integrations on top of the same public env projection model.

This creates recurring problems:

1. source sprawl
2. unclear precedence
3. convention lock-in
4. weak value/secret/public separation
5. poor debuggability
6. frontend/backend divergence
7. scaling friction
8. workspace ambiguity in monorepos and centralized-config setups

The gap: most codebases do not separate:
- the logical config model
- the physical config sources
- the resolution workflow
- the workspace selection context

CNOS fills that gap.

---

## 3. Product Thesis

CNOS is a portable, plugin-based configuration resolution system that lets applications read stable logical config keys while the actual sources, workspace selection, precedence rules, profile inheritance, secret handling, and public config export remain declarative and extensible.

Shorter form:

> **Write code against config keys, not config sources.**

---

## 4. Design Principles

1. **Stable logical key access** — app code reads keys and never cares where a value came from.
2. **Workspace-first resolution** — every invocation resolves one active workspace before config loading.
3. **Local manifest authority** — the repo-local manifest is authoritative.
4. **Global as optional lower-priority source** — global roots are data sources, not independent manifest authorities.
5. **Separation of concerns** — loading, resolution, validation, export, and dump/materialization are separate stages.
6. **Plugin-based growth** — loaders, resolvers, exporters, validators, and inspectors are pluggable.
7. **Convention-as-config** — workspace policies, profile chains, precedence, env mappings, and export rules are declared in config.
8. **Provenance-first debugging** — every resolved key is inspectable.
9. **Public and secret enforcement** — `value.*` may be promoted to public; `secret.*` never leaks to public surfaces.
10. **Simple-first adoption** — a simple single-project app can still use CNOS without monorepo complexity.
11. **Cross-language portability** — the model is not Node-only, though v1 begins in TypeScript.

---

## 5. Core Mental Model

### 5.1 Namespaces

CNOS operates on logical namespaces:

| Namespace | Purpose | Example key |
|-----------|---------|-------------|
| `value.*` | non-secret configuration values | `value.inventory.db.host` |
| `secret.*` | sensitive configuration values | `secret.inventory.db.password` |
| `meta.*` | resolution and workspace metadata | `meta.profile`, `meta.workspace` |

### 5.2 Public as Promotion, Not a Namespace Primitive

`public` is not a namespace primitive. It is a promotion mechanism.

Any `value.*` key may be promoted to public surfaces through manifest rules. `secret.*` keys can never be promoted.

### 5.3 Workspace and Meta Keys

The `meta.*` namespace is populated by CNOS core and is read-only from the application perspective.

Required v1 meta keys:

- `meta.profile`
- `meta.cnos.version`
- `meta.resolved.at`
- `meta.resolved.from`
- `meta.workspace`
- `meta.workspace.source`
- `meta.workspace.chain`
- `meta.globalRoot`
- `meta.global.enabled`

---

## 6. Workspace Model

Workspace is first-class in v1.

### 6.1 Rules

- one authoritative local manifest: `.cnos/cnos.yml`
- one active workspace per invocation
- local repo config is first-class and deployment-authoritative
- global roots are optional lower-priority data sources
- workspace inheritance is separate from profile inheritance
- dump/materialization is explicit
- global writes are supported only through explicit targeting and manifest permission

### 6.2 Workspace selection precedence

1. CLI `--workspace`
2. `.cnos-workspace.yml`
3. `workspaces.default`
4. implicit `project.name` only when no `workspaces.items` are explicitly defined

### 6.3 Global root resolution precedence

1. CLI `--global-root`
2. `.cnos-workspace.yml`
3. `workspaces.global.root`
4. `CNOS_HOME`

Global roots are active only when `workspaces.global.enabled: true`.

### 6.4 `.cnos-workspace.yml`

This file is intentionally small and only supports repo-local workspace/global-root override.

Example:

```yaml
workspace: api
globalRoot: ~/.cnos
```

It is not a second manifest.

### 6.5 WorkspaceContext

```ts
interface WorkspaceContext {
  workspaceId: string;
  workspaceSource: "cli" | "workspace-file" | "manifest-default" | "implicit";
  globalRoot?: string;
  globalRootSource?: "cli" | "workspace-file" | "manifest" | "CNOS_HOME";
  workspaceChain: string[]; // parents first, selected workspace last
  workspaceRoots: Array<{
    scope: "global" | "local";
    workspaceId: string;
    path: string;
  }>;
}
```

Workspace context is resolved before profile resolution.

---

## 7. Architecture

### 7.1 Stages

```text
Sources / Roots → Loader plugins → CNOS core (workspace, namespace, resolve, validate) → Projections / Exports / Read APIs / Dump
```

### 7.2 Package Structure

```text
packages/
  cnos/
  cli/
  vite/
  next/
```

- `@kitsy/cnos` → batteries-included entry with the core engine plus default built-in plugins
- `@kitsy/cnos-cli` → CLI commands and developer workflow surface
- `@kitsy/cnos-vite` → Vite integration
- `@kitsy/cnos-next` → Next.js integration

---

## 8. Core Domain Model

### 8.1 Types

```ts
type LogicalKey = string;
type NamespaceName = "value" | "secret" | "meta";

interface ConfigEntry {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  sourceId: string;
  pluginId: string;
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
}
```

### 8.2 Plugin Contracts

```ts
interface CnosPlugin {
  id: string;
  kind: "loader" | "resolver" | "validator" | "exporter" | "inspector";
}

interface LoaderPlugin extends CnosPlugin {
  kind: "loader";
  load(context: LoaderContext): Promise<ConfigEntry[]>;
}

interface ResolverPlugin extends CnosPlugin {
  kind: "resolver";
  resolve(entries: ConfigEntry[], context: ResolverContext): Promise<ResolvedGraph>;
}

interface ValidatorPlugin extends CnosPlugin {
  kind: "validator";
  validate(graph: ResolvedGraph, context: ValidationContext): Promise<ValidationResult>;
}

interface ExporterPlugin extends CnosPlugin {
  kind: "exporter";
  export(graph: ResolvedGraph, context: ExportContext): Promise<ExportResult>;
}

interface InspectorPlugin extends CnosPlugin {
  kind: "inspector";
  inspect(key: LogicalKey, graph: ResolvedGraph, context: InspectContext): Promise<InspectResult>;
}
```

### 8.3 Context Objects

```ts
interface LoaderContext {
  manifestConfig: Record<string, unknown>;
  profile: string;
  profileChain: string[];
  manifestRoot: string;
  workspace: WorkspaceContext;
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
}

interface ResolverContext {
  manifest: NormalizedManifest;
  profile: string;
  profileChain: string[];
  precedenceOrder: string[];
  workspace: WorkspaceContext;
}

interface ValidationContext {
  manifest: NormalizedManifest;
  schema?: Record<LogicalKey, SchemaRule>;
}

interface ExportContext {
  manifest: NormalizedManifest;
  promotions: PromotionRule[];
  frameworkPrefixes?: string[];
  workspace: WorkspaceContext;
}

interface InspectContext {
  manifest: NormalizedManifest;
  workspace: WorkspaceContext;
}
```

---

## 9. Root Manifest

CNOS root manifest: `.cnos/cnos.yml`

### 9.1 Complete v1 shape

```yaml
version: 1

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
    db:
      extends: [base]
    agents:
      extends: [base]

profiles:
  default: local
  resolveFrom:
    - cli.profile
    - env.CNOS_PROFILE
    - default

plugins:
  loaders:
    - filesystem-values
    - filesystem-secrets
    - dotenv
    - process-env
    - cli-args
  resolver: profile-aware
  validators:
    - basic-schema
  exporters:
    - env
    - public-env
  inspectors:
    - provenance

sources:
  filesystem-values:
    root: ./workspaces/{workspace}/values
    format: yaml

  filesystem-secrets:
    root: ./workspaces/{workspace}/secrets
    format: yaml

  dotenv:
    root: ./workspaces/{workspace}/env

resolution:
  precedence:
    - filesystem-values
    - filesystem-secrets
    - dotenv
    - process-env
    - cli-args
  arrayPolicy: replace

envMapping:
  convention: SCREAMING_SNAKE
  explicit:
    DATABASE_HOST: value.inventory.db.host
    DATABASE_PASSWORD: secret.inventory.db.password
    NEXT_PUBLIC_API_BASE_URL: value.api.baseUrl

public:
  promote:
    - value.api.baseUrl
    - value.api.version
    - value.app.name
  frameworks:
    next: NEXT_PUBLIC_
    vite: VITE_
    nuxt: NUXT_PUBLIC_

writePolicy:
  define:
    defaultProfile: local
    targets:
      value: ./values/app.yml
      secret: ./secrets/app.yml

schema:
  value.server.port:
    type: number
    required: true
  value.server.host:
    type: string
    required: true
    default: "127.0.0.1"
  value.api.baseUrl:
    type: string
    required: true
  secret.inventory.db.password:
    type: string
    required: true
```

### 9.2 Authority rule

The local manifest defines:
- plugins
- precedence
- public promotion
- schema
- workspace rules
- write rules

Global roots do not override manifest authority in v1.

---

## 10. Filesystem Convention

### 10.1 Local layout

```text
.cnos/
  cnos.yml
  workspaces/
    api/
      profiles/
      values/
      secrets/
      env/
    db/
      profiles/
      values/
      secrets/
      env/
```

### 10.2 Global layout

```text
~/.cnos/
  workspaces/
    api/
      profiles/
      values/
      secrets/
      env/
```

### 10.3 Namespace-to-directory mapping

| Source root | Namespace produced |
|-------------|-------------------|
| `values/` | `value.*` |
| `secrets/` | `secret.*` |
| `env/` | mapped via `envMapping` |

---

## 11. Workspace and Profile Expansion

### 11.1 Workspace inheritance

- workspace inheritance composes config tree roots
- parent workspaces expand before child
- cycles are hard errors

### 11.2 Profile inheritance

Profiles remain environment selectors within the selected workspace.

Example profile:

```yaml
name: local
extends: [base]

activate:
  values:
    - base
    - local
  secrets:
    - local
  envFiles:
    - .env
    - .env.local
```

### 11.3 Effective root order for loaders

1. global parent workspaces
2. global active workspace
3. local parent workspaces
4. local active workspace

Within each root, profile activation proceeds normally.

This ensures:
- global is lower priority than local
- parents are lower priority than children
- workspace composition happens before normal source precedence

---

## 12. Loaders (v1)

### 12.1 `filesystem-values`
- reads YAML from all effective workspace roots under `values/`
- profile activation filters subdirectories
- outputs `value.*`
- provenance includes workspace ID and file path

### 12.2 `filesystem-secrets`
- reads YAML from all effective workspace roots under `secrets/`
- outputs `secret.*`
- local secret material is stored outside the repo in encrypted vault storage
- repo YAML stores only refs such as `provider`, `vault`, and logical `ref`

### 12.3 `dotenv`
- reads env files from all effective workspace roots under `env/`
- maps env vars through `envMapping`

### 12.4 `process-env`
- reads runtime env
- maps env vars through same mapping rules

### 12.5 `cli-args`
- supports:
  - `--value.server.port=8080`
  - `--secret.inventory.db.password=...`
  - `--profile=stage`
  - `--workspace=api`
  - `--global-root=/path/to/.cnos`

---

## 13. Resolution

### 13.1 Single resolver: `profile-aware`

v1 uses one resolver:

1. resolve workspace context
2. expand workspace chain
3. resolve active profile
4. expand profile chain
5. load entries from all configured loaders and effective roots
6. apply precedence order
7. deep merge objects
8. overwrite scalars by higher precedence
9. apply array policy
10. emit `ResolvedGraph`

### 13.2 Missing key behavior
- `read(key)` → undefined
- `require(key)` → throws
- `readOr(key, fallback)` → fallback

---

## 14. Validation

Built-in validator supports:
- `type`
- `required`
- `enum`
- `pattern`
- `default`

Additional v1 validations:
- workspace inheritance graph is acyclic
- profile inheritance graph is acyclic
- `public.promote` contains only `value.*`
- no ambiguous env mapping collisions
- global writes disallowed unless `workspaces.global.allowWrite: true`

---

## 15. Inspection / Provenance

### 15.1 Inspect result

```ts
interface InspectResult {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  profile: string;
  profileSource: string;
  workspace: {
    id: string;
    source: string;
    chain: string[];
  };
  winner: {
    sourceId: string;
    pluginId: string;
    workspaceId: string;
    origin?: {
      file?: string;
      line?: number;
      envVar?: string;
      cliArg?: string;
    };
  };
  overridden: Array<{
    sourceId: string;
    pluginId: string;
    workspaceId: string;
    value: unknown;
    origin?: {
      file?: string;
      line?: number;
      envVar?: string;
      cliArg?: string;
    };
  }>;
}
```

### 15.2 What inspect answers
- final value
- active workspace
- active profile
- how workspace/profile were selected
- winning source
- override chain

---

## 16. Export / Projection / Dump

### 16.1 `toEnv()`
Exports full resolved graph except `meta.*`.

### 16.2 `toPublicEnv()`
Exports promoted `value.*` keys only.

CLI note:
- `cnos export env` should emit only explicitly mapped env exports by default
- public/browser env output comes from `public.promote` plus framework prefix rules
- ambient process env is not a list/export surface unless explicitly requested by a future debug mode

### 16.3 `dump`
Materializes snapshot config trees to disk.

Two modes:
- workspace-preserving dump
- standalone flatten dump

Examples:
```bash
cnos dump --workspace api --to ./.cnos/workspaces/api
cnos dump --workspace api --flatten --to ./.cnos
```

Dump is a snapshot, not a live redirect.

This is the reproducibility bridge between centralized/global config and deployment-local config.

---

## 17. Env Mapping

Convention-based mapping:
- `value.server.port` -> `SERVER_PORT`
- `secret.inventory.db.password` -> `SECRET_INVENTORY_DB_PASSWORD`

Explicit mappings override convention.

Mapping is bidirectional:
- env -> logical key
- logical key -> env

---

## 18. Runtime API

### 18.1 Constructor

```ts
interface CreateCnosOptions {
  root?: string;
  profile?: string;
  workspace?: string;
  globalRoot?: string;
  plugins?: CnosPlugin[];
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
}
```

### 18.2 Runtime

```ts
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

  readonly graph: ResolvedGraph;
}
```

---

## 19. CLI Specification

All relevant commands accept `--workspace`.

### 19.1 `cnos init`
Scaffolds workspace-aware structure and `.gitignore` entries.

### 19.2 `cnos read <logical-key>`
Reads a resolved key for the selected workspace.

### 19.3 `cnos value <path>` / `cnos secret <path>`
Convenience aliases.

`cnos use show` reads the current repo-local CLI context without mutating `.cnos-workspace.yml`.

### 19.4 `cnos define <namespace> <path> <value>`
Default writes to local selected workspace.

Explicit global write:
```bash
cnos define value "server.port" "8080" --workspace api --target global
```

Rules:
- deterministic write target
- must honor `writePolicy`
- `--target global` requires `workspaces.global.allowWrite: true`
- namespace/file safety enforced

### 19.5 `cnos inspect <logical-key>`
Shows workspace-aware provenance.

### 19.6 `cnos validate`
Runs schema, public safety, workspace graph, and write-policy checks.

### 19.7 `cnos export env`
Env flattening only.

Rules:
- default output is explicit env exports only
- public output requires `--public`
- framework public output may apply `vite`, `next`, or other configured prefixes

### 19.8 `cnos dump`
Filesystem materialization only.

### 19.9 `cnos run -- <command>`
Resolves config for selected workspace and injects env.

### 19.10 `cnos diff`
Compares resolved config between profiles, or later between workspaces.

### 19.11 `cnos doctor`
Checks:
- manifest validity
- workspace graph
- profile graph
- source roots
- `.gitignore`
- mapping collisions
- global policy consistency

### 19.12 `cnos list`
Supports:
- `cnos list value`
- `cnos list secret`
- `cnos list meta`
- `cnos list env`
- `cnos list public`

Rules:
- `list value` and `list secret` show stored CNOS config, not ambient process env winners
- `list env` shows only explicit env exports
- `list public` shows promoted public env output

### 19.13 `cnos secret create vault <name>`
Creates a local encrypted secret vault outside the repo.

### 19.14 Error output
CLI commands print concise error messages by default.

Use `--verbose` to request stack traces and full diagnostics.

---

## 20. Write Policy

### 20.1 Default
`define` writes to local selected workspace subtree.

### 20.2 Explicit global write
Allowed only when:
- `--target global`
- `workspaces.global.allowWrite: true`
- global root resolves

### 20.3 Determinism
The same namespace/path/profile/workspace/target tuple must always resolve to the same file.

---

## 21. Internal Module Layout

```text
packages/core/src/
  index.ts
  types/
    core.ts
    plugin.ts
    manifest.ts
    workspace.ts
    profile.ts
    schema.ts
    export.ts
  manifest/
    loadManifest.ts
    normalizeManifest.ts
    loadWorkspaceFile.ts
  workspaces/
    resolveWorkspaceContext.ts
    expandWorkspaceChain.ts
  profiles/
    resolveActiveProfile.ts
    expandProfileChain.ts
  orchestrator/
    createCnos.ts
    runtime.ts
    pipeline.ts
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
  exporters/
    toEnv.ts
    toPublicEnv.ts
    dump.ts
  inspectors/
    provenance.ts
  utils/
    path.ts
    flatten.ts
    deepMerge.ts
    yaml.ts
    envNaming.ts
```

---

## 22. Testing Requirements

### Unit tests
- workspace selection precedence
- global root selection precedence
- workspace graph expansion and cycles
- local-over-global ordering
- loader behavior with multiple roots
- profile resolution
- mapping and promotion logic
- explicit global writes
- meta keys population

### Integration tests
- local-only workspace resolution
- global + local layering where local wins
- parent + child workspace layering
- profile activation within selected workspace
- `inspect()` with workspace-aware provenance
- `define` local write
- `define --target global`
- `dump --flatten`
- monorepo fixture with `base`, `api`, `agents`

### Golden tests
- inspect output
- doctor output
- dump output tree
- export env output

---

## 23. Scope Boundaries

### In v1
- workspace-aware manifest and loader pipeline
- optional global roots
- explicit global write target
- dump/materialization
- full CLI with workspace support

### Deferred beyond v1
- hosted Kitsy root as built-in remote plugin
- encrypted secret files
- Kubernetes-native plugin
- browser runtime package
- live sync/watch
- advanced policy engine
- language ports

---

## 24. Hard Constraints

1. `secret.*` must never be promoted to public.
2. Local manifest is authoritative.
3. Global roots are opt-in only.
4. Workspace context resolves before profile resolution.
5. CLI write routing must be deterministic.
6. `dump` is separate from env export.
7. Local remains deployment-authoritative even when global is used.
8. Global writes must be explicit, never implicit.
9. Plugin boundaries must remain intact.

---

## 25. Incremental Delivery Plan

### Phase 1: Workspace foundation + filesystem
- manifest + workspace file loading
- workspace context resolution
- workspace chain expansion
- filesystem loaders with multi-root input
- runtime reads
- meta keys

### Phase 2: remaining loaders + precedence + provenance
- dotenv/process-env/cli-args
- full precedence
- inspect/provenance

### Phase 3: profiles + exporters + dump
- profile expansion
- env export
- public export
- dump/materialization

### Phase 4: CLI
- init, read, value, secret, inspect, validate, export, dump, run, diff, doctor, define
- workspace/global flags
- explicit global write mode

### Phase 5: validation + polish
- schema validator
- workspace/public safety validators
- tests
- docs/examples

---

## 26. What Makes CNOS Strong

1. logical key API
2. workspace-first config resolution
3. plugin-based architecture
4. local-first reproducibility with optional global centralization
5. deterministic CLI define/dump flows
6. provenance inspection
7. public promotion without fake namespace inflation
8. `cnos run` and `cnos dump` as practical adoption paths
