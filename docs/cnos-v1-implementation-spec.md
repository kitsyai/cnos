# CNOS v1 — Implementation Specification

**Project:** `@kitsy/cnos`  
**Core package:** `@kitsy/cnos-core`  
**CLI package:** `@kitsy/cnos-cli`  
**Status:** Draft v1 implementation specification  
**Intended audience:** code agents, architects, maintainers, reviewers

---

## 1. Purpose

This document translates the CNOS product and architecture direction into an implementation-ready v1 specification.

CNOS is a **configuration workflow orchestrator**. Application code reads stable logical config keys, while CNOS coordinates how configuration is:

- read from one or more sources
- normalized into a common internal model
- resolved through precedence and profile rules
- validated
- inspected for provenance
- exported into downstream surfaces such as env maps or public client-safe config

The v1 goal is not to solve the entire configuration spectrum. The v1 goal is to build a clean, extensible, plugin-based system that delivers an excellent Node/TypeScript wedge while preserving the architecture needed to support richer workflows later.

---

## 2. Scope

### 2.1 In scope for v1

- `@kitsy/cnos-core` workflow orchestrator
- plugin contracts
- default v1 plugin registry
- filesystem values reader plugin
- filesystem secrets reader plugin
- dotenv reader plugin
- process env reader plugin
- CLI args reader plugin
- simple merge resolver
- inherited/profile-aware resolver
- deterministic precedence handling
- logical namespace access:
  - `value.*`
  - `secret.*`
  - `public.*`
  - `meta.*`
- runtime API:
  - `read`
  - `require`
  - `readOr`
  - `inspect`
  - `toObject`
  - `toNamespace`
  - `toEnv`
  - `toPublicEnv`
- starter CLI:
  - `init`
  - `read`
  - `value`
  - `define`
  - `inspect`
  - `validate`
  - `export`
  - `doctor`
- optional schema validation with a minimal built-in validator
- provenance metadata for resolved keys
- public export guardrails
- monorepo-aware architecture, even if workspace support is limited in v1

### 2.2 Out of scope for v1

- remote secret managers
- encrypted local secret storage
- Kubernetes-native plugin
- distributed config sync
- watch mode / hot reload
- browser runtime package
- language ports to Go/Java/Rust
- GUI/admin dashboard
- advanced policy engine
- full workspace orchestration across many packages

---

## 3. Non-Negotiable Principles

1. Application code reads logical keys and never depends directly on source-specific conventions.
2. Core orchestration must remain plugin-based.
3. Conventions must be declarative and representable in config.
4. `public.*` is exportable; `secret.*` is never exportable to public surfaces.
5. Resolution must be deterministic and inspectable.
6. `.env`-style adoption must remain easy.
7. Core config model must be portable beyond Node, even if implemented in TypeScript first.

---

## 4. Package Layout

Recommended initial monorepo package layout:

```text
packages/
  cnos-core/
  cnos/
  cnos-cli/
```

### 4.1 `@kitsy/cnos-core`
Owns:
- plugin interfaces
- normalized internal config graph model
- workflow orchestrator
- source loading pipeline
- resolution pipeline
- validation pipeline
- inspection/provenance pipeline
- export/projection pipeline

### 4.2 `@kitsy/cnos`
Owns:
- batteries-included developer entry point
- re-export of core runtime
- default v1 plugins wired together
- ergonomic `createCnos(...)` entry

### 4.3 `@kitsy/cnos-cli`
Owns:
- command parsing
- reading project manifest
- loading runtime with default plugins
- value inspection and mutation flows
- human-readable and machine-readable output

---

## 5. Filesystem Convention for v1 Starter

Recommended scaffold:

```text
cnos/
  cnos.yml

  profiles/
    profile.yml
    local.yml
    stage.yml
    prod.yml

  values/
    base/
      app.yml
    local/
      app.yml
    stage/
      app.yml
    prod/
      app.yml

  secrets/
    local/
      app.yml
    stage/
      app.yml
    prod/
      app.yml

  env/
    .env
    .env.local
    .env.stage
    .env.prod
```

Notes:
- `values/` and `secrets/` are physical storage folders
- logical access remains singular: `value.*`, `secret.*`
- domain files such as `app.yml`, `inventory.yml` are preferred over one large file
- v1 should allow future extension without changing the runtime access model

---

## 6. Root Manifest

CNOS root manifest file: `cnos/cnos.yml`

Responsibilities:
- declare version
- declare default plugins
- declare physical sources
- declare profile resolution flow
- declare namespace routing
- declare precedence
- declare export rules
- declare write policies for CLI `define`

Illustrative shape:

```yaml
version: 1

project:
  name: my-service

profiles:
  default: local
  resolveFrom:
    - cli.profile
    - env.CNOS_PROFILE
    - default

plugins:
  readers:
    - filesystem-values
    - filesystem-secrets
    - dotenv
    - process-env
    - cli-args
  resolvers:
    - inherited-resolution
  validators:
    - basic-schema
  exporters:
    - env
    - public-env
  inspectors:
    - provenance

sources:
  filesystemValues:
    plugin: filesystem-values
    root: ./values
    format: yaml

  filesystemSecrets:
    plugin: filesystem-secrets
    root: ./secrets
    format: yaml

  dotenv:
    plugin: dotenv
    root: ./env

resolution:
  precedence:
    - profile-files
    - dotenv
    - process-env
    - cli-args

  namespaces:
    value:
      readers: [filesystem-values, dotenv, process-env, cli-args]
    secret:
      readers: [filesystem-secrets, dotenv, process-env, cli-args]
    public:
      readers: [filesystem-values, dotenv, process-env, cli-args]

writePolicy:
  define:
    defaultProfile: local
    targets:
      value: ./values/{profile}/app.yml
      secret: ./secrets/{profile}/app.yml
      public: ./values/{profile}/public.yml

export:
  public:
    fromNamespaces: [public]
    allowedPrefixes: [PUBLIC_, NEXT_PUBLIC_, VITE_]
```

The exact schema can evolve, but the document must remain readable and explicit.

---

## 7. Core Domain Model

The core must normalize everything into a language-neutral domain model.

### 7.1 Logical Key

```ts
type LogicalKey = string;
// examples:
// "value.inventory.db.host"
// "secret.inventory.db.password"
// "public.api.baseUrl"
```

### 7.2 Namespace

```ts
type NamespaceName = "value" | "secret" | "public" | "meta";
```

### 7.3 Config Entry

```ts
interface ConfigEntry {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  sourceId: string;
  pluginId: string;
  profile?: string;
  origin?: {
    file?: string;
    line?: number;
    column?: number;
    envVar?: string;
    cliArg?: string;
  };
  metadata?: Record<string, unknown>;
}
```

### 7.4 Resolved Entry

```ts
interface ResolvedEntry {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  winner: ConfigEntry;
  overridden: ConfigEntry[];
}
```

### 7.5 Resolved Graph

```ts
interface ResolvedGraph {
  entries: Map<LogicalKey, ResolvedEntry>;
  profile: string;
}
```

---

## 8. Plugin Contracts

Plugins are the main extension mechanism.

### 8.1 Base plugin contract

```ts
interface CnosPlugin {
  id: string;
  kind: "reader" | "resolver" | "validator" | "exporter" | "inspector";
}
```

### 8.2 Reader plugin

Reads physical config and returns normalized entries.

```ts
interface ReaderPlugin extends CnosPlugin {
  kind: "reader";
  read(context: ReaderContext): Promise<ConfigEntry[]>;
}
```

### 8.3 Resolver plugin

Consumes normalized entries and produces a resolved graph.

```ts
interface ResolverPlugin extends CnosPlugin {
  kind: "resolver";
  resolve(
    entries: ConfigEntry[],
    context: ResolverContext
  ): Promise<ResolvedGraph>;
}
```

### 8.4 Validator plugin

```ts
interface ValidatorPlugin extends CnosPlugin {
  kind: "validator";
  validate(graph: ResolvedGraph, context: ValidationContext): Promise<ValidationResult>;
}
```

### 8.5 Exporter plugin

```ts
interface ExporterPlugin extends CnosPlugin {
  kind: "exporter";
  export(graph: ResolvedGraph, context: ExportContext): Promise<ExportResult>;
}
```

### 8.6 Inspector plugin

```ts
interface InspectorPlugin extends CnosPlugin {
  kind: "inspector";
  inspect(key: LogicalKey, graph: ResolvedGraph, context: InspectContext): Promise<InspectResult>;
}
```

---

## 9. v1 Default Plugins

### 9.1 Reader plugins

#### `filesystem-values`
- reads YAML files from configured `values/` root
- maps nested YAML structure into logical keys under `value.*` or `public.*` depending on path/policy
- associates file provenance

#### `filesystem-secrets`
- reads YAML files from configured `secrets/` root
- maps nested YAML structure into logical keys under `secret.*`
- associates file provenance

#### `dotenv`
- reads `.env` files selected by active profile
- maps env vars into logical keys through declared mappings and/or conventions

#### `process-env`
- reads `process.env`
- maps env vars into logical keys through declared mappings

#### `cli-args`
- reads command-line args
- supports direct override expressions such as:
  - `--value.server.port=8080`
  - `--secret.inventory.db.password=...`
  - `--profile=stage`

### 9.2 Resolver plugins

#### `simple-resolution`
- deep merge maps
- scalar last-writer-wins
- configurable array merge policy
- no inheritance logic beyond raw precedence

#### `inherited-resolution`
- profile-aware
- activates configured profile layers
- applies inheritance / extends graph
- then resolves using deterministic precedence

### 9.3 Validator plugins

#### `basic-schema`
- supports required/type/enum/pattern/default
- validates namespace expectations
- validates public/secret export boundaries

### 9.4 Exporter plugins

#### `env`
- exports resolved values into a flat env map

#### `public-env`
- exports only `public.*`
- blocks any `secret.*`
- supports user-declared public prefixes

### 9.5 Inspector plugins

#### `provenance`
- returns winning source
- shows override chain
- shows origin details if available

---

## 10. Profile Model

### 10.1 Profile activation

Each profile can:
- extend one or more parent profiles
- activate value directories
- activate secret directories
- activate env files

Example:

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

### 10.2 Requirements

- profile inheritance cycles must be detected
- profile activation order must be deterministic
- parent profiles must be applied before child profiles
- explicit profile selection precedence:
  1. CLI `--profile`
  2. `CNOS_PROFILE`
  3. manifest default

---

## 11. Resolution Rules

### 11.1 Merge behavior

Default rules:
- objects/maps: deep merge
- scalars: override by later-precedence entry
- arrays: default `replace`

v1 may allow an optional per-key or global array policy.

### 11.2 Precedence

Default lowest to highest:
1. filesystem/profile layers
2. dotenv files
3. process env
4. CLI args

### 11.3 Conflict handling

- conflicts are allowed and resolved by precedence
- `inspect()` must show the full override chain
- optional future warning for suspicious shadowing can be deferred

---

## 12. Runtime API

### 12.1 Constructor

```ts
interface CreateCnosOptions {
  root?: string;
  profile?: string;
  plugins?: CnosPlugin[];
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
}
```

### 12.2 Main runtime interface

```ts
interface CnosRuntime {
  read<T = unknown>(key: LogicalKey): T | undefined;
  require<T = unknown>(key: LogicalKey): T;
  readOr<T>(key: LogicalKey, fallback: T): T;
  inspect(key: LogicalKey): InspectResult;
  toObject(): Record<string, unknown>;
  toNamespace(namespace: NamespaceName): Record<string, unknown>;
  toEnv(options?: ToEnvOptions): Record<string, string>;
  toPublicEnv(options?: ToPublicEnvOptions): Record<string, string>;
}
```

### 12.3 Convenience helpers

Optional ergonomic helpers:

```ts
interface CnosRuntimeHelpers {
  value<T = unknown>(path: string): T | undefined;
  secret<T = unknown>(path: string): T | undefined;
  public<T = unknown>(path: string): T | undefined;
}
```

These should internally map:
- `"inventory.db.host"` -> `"value.inventory.db.host"`

---

## 13. Inspect Result

Suggested shape:

```ts
interface InspectResult {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  profile: string;
  winner: {
    sourceId: string;
    pluginId: string;
    origin?: {
      file?: string;
      line?: number;
      column?: number;
      envVar?: string;
      cliArg?: string;
    };
  };
  overridden: Array<{
    sourceId: string;
    pluginId: string;
    origin?: {
      file?: string;
      line?: number;
      column?: number;
      envVar?: string;
      cliArg?: string;
    };
    value: unknown;
  }>;
}
```

---

## 14. Env Mapping

v1 should support two-way env interop.

### 14.1 Env -> logical key

Manifest-declared mapping example:

```yaml
envMapping:
  DATABASE_HOST: value.inventory.db.host
  DATABASE_PASSWORD: secret.inventory.db.password
  NEXT_PUBLIC_API_BASE_URL: public.api.baseUrl
```

### 14.2 Logical key -> env export

`toEnv()` and CLI `export env` should support:
- prefix rules
- flattening style
- include/exclude namespace filters

### 14.3 Default flattening convention

Recommended default:
- `value.server.port` -> `SERVER_PORT`
- `public.api.baseUrl` -> `PUBLIC_API_BASE_URL`

Framework-specific transforms can be added later.

---

## 15. CLI Specification

### 15.1 `cnos init`

Creates:
- starter `cnos/` directory
- starter `cnos.yml`
- profile files
- sample values/secrets/env files

### 15.2 `cnos read <logical-key>`

Reads a logical key.

Example:
```bash
cnos read value.inventory.db.host
```

### 15.3 `cnos value <path>`

Convenience alias for `value.*`.

Example:
```bash
cnos value "inventory.db.host"
```

Equivalent to:
```bash
cnos read value.inventory.db.host
```

### 15.4 `cnos define <namespace> <path> <value>`

Writes or updates config without requiring the user to locate the right file manually.

Examples:
```bash
cnos define value "inventory.db.host" "127.0.0.1"
cnos define secret "inventory.db.password" "s3cr3t"
cnos define public "api.baseUrl" "https://example.com"
```

Requirements:
- target file chosen by `writePolicy`
- create file if needed
- deep-write YAML path
- preserve existing content where possible
- support `--profile`
- support `--file` override for explicit targeting if needed
- never allow `define public` to write into `secrets/`

### 15.5 `cnos inspect <logical-key>`

Shows provenance.

### 15.6 `cnos validate`

Runs validation plugins.

### 15.7 `cnos export env`

Exports flat env output.
Flags:
- `--profile`
- `--public`
- `--json`

### 15.8 `cnos doctor`

Runs system checks:
- manifest readable
- profile graph valid
- source roots exist or are createable
- no secret/public export policy violations
- required keys present if schema exists

---

## 16. Write Policy for `define`

This deserves explicit design.

### 16.1 Goals
- no manual file hunting
- deterministic file targeting
- profile-sensitive defaults
- safe namespace/file boundaries

### 16.2 Default write routing
Given:
```yaml
writePolicy:
  define:
    defaultProfile: local
    targets:
      value: ./values/{profile}/app.yml
      secret: ./secrets/{profile}/app.yml
      public: ./values/{profile}/public.yml
```

Then:
- `cnos define value "server.port" 3000` writes to `values/local/app.yml` by default
- `cnos define secret "db.password" "..." --profile stage` writes to `secrets/stage/app.yml`
- `cnos define public "api.baseUrl" ...` writes to `values/local/public.yml`

### 16.3 Guardrails
- no writing secrets into values path
- no writing public into secrets path
- profile must resolve before write
- if target path does not exist, create it
- preserve comments when possible, but correctness first in v1

---

## 17. Validation Rules

Built-in minimal schema model should support:

```ts
interface BasicRule {
  type?: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  enum?: unknown[];
  pattern?: string;
  default?: unknown;
}
```

Optional manifest section:

```yaml
schema:
  value.server.port:
    type: number
    required: true
  value.server.host:
    type: string
    required: true
  public.api.baseUrl:
    type: string
    required: true
  secret.inventory.db.password:
    type: string
    required: true
```

Validation should:
- report all failures
- optionally apply defaults before final resolution export if enabled
- never invent secret defaults silently unless explicitly declared

---

## 18. Public Export Safety

This is a hard requirement.

### 18.1 Rules
- only `public.*` can be exported through `toPublicEnv()` or `public-env` exporter
- `secret.*` must never be exported
- `value.*` must never be exported through public export unless explicitly projected into `public.*`
- export validators should fail closed, not fail open

### 18.2 Recommendation
Treat public export as a separate projection stage, not a loose filtering convenience.

---

## 19. Internal Module Layout Recommendation

For `packages/cnos-core/src/`:

```text
src/
  index.ts
  types/
    core.ts
    plugin.ts
    manifest.ts
    profile.ts
  orchestrator/
    createCnos.ts
    runtime.ts
    pipeline.ts
  manifest/
    loadManifest.ts
    normalizeManifest.ts
  profiles/
    resolveActiveProfile.ts
    expandProfileGraph.ts
  readers/
    filesystemValues.ts
    filesystemSecrets.ts
    dotenv.ts
    processEnv.ts
    cliArgs.ts
  resolvers/
    simpleResolution.ts
    inheritedResolution.ts
  validators/
    basicSchema.ts
  exporters/
    toEnv.ts
    toPublicEnv.ts
  inspectors/
    provenance.ts
  utils/
    path.ts
    flatten.ts
    deepMerge.ts
    yaml.ts
```

---

## 20. Testing Requirements

### 20.1 Unit tests
- manifest normalization
- profile resolution
- deep merge semantics
- namespace routing
- env mapping
- public export safety
- write routing for `define`

### 20.2 Integration tests
- starter project with `local`, `stage`, `prod`
- layered resolution
- dotenv + process env + CLI precedence
- inspect/provenance output
- CLI define then runtime read
- CLI export public env
- invalid schema failure
- inheritance cycle detection

### 20.3 Golden tests
Useful for:
- CLI human output
- exported env maps
- inspect provenance payload

---

## 21. Initial Developer Experience Targets

The v1 developer experience should feel good in both of these cases:

### 21.1 Simple app
A user with only `.env` and one Node app should be able to:
- install `@kitsy/cnos`
- run `cnos init`
- move config gradually
- read values immediately

### 21.2 Growing system
A user with multiple envs and services should be able to:
- define profile layering
- separate values and secrets
- export public config safely
- inspect why a key resolved to a value
- avoid custom app-specific config glue code

---

## 22. Incremental Delivery Plan

### Phase 1
- core types
- manifest loader
- simple reader pipeline
- filesystem values/secrets plugins
- simple resolver
- runtime `read/require/readOr`

### Phase 2
- dotenv/process-env/cli-args readers
- precedence pipeline
- inspect/provenance

### Phase 3
- profile inheritance
- inherited resolver
- export env/public env

### Phase 4
- CLI `init/read/value/inspect/export`
- CLI `define`
- write policy routing

### Phase 5
- basic schema validator
- doctor command
- docs/examples

---

## 23. Codex Delivery Guardrails

Any implementing code agent must preserve these constraints:

- do not hardcode dotenv-only assumptions into core
- do not bake profile naming conventions into application runtime APIs
- do not collapse plugin boundaries “for simplicity”
- do not allow public export of `secret.*`
- do not make CLI writes nondeterministic
- do not tie manifest semantics to Node-only constructs where avoidable
- do not invent framework-specific behavior inside core unless behind plugins or exporter options

---

## 24. Final Implementation Recommendation

Build `@kitsy/cnos-core` first as a true workflow orchestrator with explicit plugin contracts.

Then ship `@kitsy/cnos` as the easy adoption surface with default v1 plugins.

Then ship `@kitsy/cnos-cli` as the developer workflow companion.

The invariant that must not change is:

> Application code reads logical config keys. CNOS plugins decide how config is read, resolved, validated, inspected, and exported.
