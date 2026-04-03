# CNOS v1 — Canonical Specification

**Project:** `@kitsy/cnos`
**Packages:** `@kitsy/cnos-core`, `@kitsy/cnos`, `@kitsy/cnos-cli`
**Status:** Implementation-ready v1 specification
**License intent:** Open source

---

## 1. What CNOS Is

CNOS is a **configuration resolution system**.

It sits between configuration sources and application surfaces. On one side, loader plugins ingest config from files, `.env`, shell env, CLI args, and — in the future — remote stores, GitHub, secret providers, and kube-like sources. In the middle, CNOS core collects everything into one logical config graph, applies namespaces, resolves precedence and inheritance, and produces the final resolved config map. On the other side, output surfaces consume that resolved map in the form they need: application code reads logical keys, frontends get public-safe config, CLI tools inspect and define values, and env exporters flatten the graph for downstream tooling.

The mental model:

```
Sources → Loader plugins → CNOS core (namespace, resolve, validate) → Projections / Exports / Read APIs
```

The invariant:

> **Application code reads logical keys. CNOS decides where values come from and how they're resolved. Plugins extend both sides.**

---

## 2. Why CNOS Exists

Configuration gets scattered across `.env` files, shell variables, YAML files, CLI args, CI/CD injected vars, framework-specific public env conventions, and secret files. This creates recurring problems:

1. **Source sprawl** — values live in many places with no unified model.
2. **Unclear precedence** — teams don't know whether file config, env vars, or CLI args win.
3. **Convention lock-in** — app code hardcodes one pattern, making migration painful.
4. **Weak value/secret/public separation** — secrets leak through build tooling, public-safe values aren't enforced.
5. **Poor debuggability** — "why did this key resolve to this value?" is unanswerable.
6. **Frontend/backend divergence** — server, browser, build-time, and runtime surfaces all behave differently.
7. **Scaling friction** — teams start with `.env`, then need layered config without rewriting app code.

The gap: most codebases don't separate the **logical config model** (what app code depends on) from **physical config sources** (where values are stored) from the **resolution workflow** (how precedence and merging work). CNOS fills that gap.

---

## 3. Product Thesis

CNOS is a portable, plugin-based configuration resolution system that lets applications read stable logical config keys while the actual sources, precedence rules, profile inheritance, secret handling, and public config export remain declarative and extensible.

Shorter form:

> **Write code against config keys, not config sources.**

---

## 4. Design Principles

1. **Stable logical key access** — app code reads keys and never cares where a value came from.
2. **Separation of concerns** — loading, resolution, validation, and export are independent stages.
3. **Plugin-based growth** — loaders, resolvers, exporters, validators, and inspectors are pluggable.
4. **Convention-as-config** — profile chains, precedence, env mappings, and export rules are declared in the manifest, not hardcoded.
5. **Provenance-first debugging** — every resolved key is inspectable: which source won, what got overridden, and why.
6. **Public and secret enforcement** — `public.*` is explicitly exported; `secret.*` never leaks to public surfaces. Fail closed.
7. **Simple-first adoption** — a `.env`-using app adopts CNOS without pain; `cnos run` works with zero code changes.
8. **Cross-surface support** — build-time, runtime, server-side, and client-side consumers fit the same model.
9. **Cross-language portability** — the config model isn't Node-only, even though v1 starts in TypeScript.

---

## 5. Core Mental Model

### 5.1 Namespaces

CNOS operates on **logical namespaces**. These are the namespace primitives — the fundamental categories of config:

| Namespace | Purpose | Example key |
|-----------|---------|-------------|
| `value.*` | Non-secret configuration values | `value.inventory.db.host` |
| `secret.*` | Sensitive configuration values | `secret.inventory.db.password` |
| `meta.*` | Resolution metadata and runtime context | `meta.profile`, `meta.cnos.version` |

### 5.2 Public as Promotion, Not a Namespace Primitive

`public` is **not** a namespace primitive. It is a **promotion mechanism**.

Any `value.*` key can be promoted to a public surface. Promotion is declared in the manifest, not in the key's namespace. A value promoted to public becomes available through `toPublicEnv()` and public export surfaces, but the canonical key remains `value.*`.

This means:
- There is no `public.*` prefix in the logical key space.
- A key like `value.api.baseUrl` can be promoted to public via manifest rules.
- Promoted keys are projected into framework-specific forms: `NEXT_PUBLIC_API_BASE_URL`, `VITE_API_BASE_URL`, `NUXT_PUBLIC_API_BASE_URL`, etc.
- `secret.*` keys can **never** be promoted to public. This is a hard constraint.

### 5.3 Well-Known Meta Keys

The `meta.*` namespace is populated by CNOS core during resolution. It is read-only from the application's perspective.

| Key | Value | Source |
|-----|-------|--------|
| `meta.profile` | Active profile name | Profile resolver |
| `meta.cnos.version` | CNOS runtime version | Core |
| `meta.resolved.at` | ISO timestamp of resolution | Core |
| `meta.resolved.from` | How profile was determined (`cli`, `env`, `manifest-default`) | Profile resolver |

Meta keys are accessible via `cnos.read("meta.profile")` and visible in `cnos.toObject()`.

### 5.4 Logical Keys

A logical key is a dot-separated path rooted in a namespace:

```
value.inventory.db.host
secret.inventory.db.password
meta.profile
```

The first segment is always the namespace. The rest is the config path within that namespace.

---

## 6. Architecture

### 6.1 The Three Stages

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────────────┐
│  LOADER PLUGINS  │ ──▶ │     CNOS CORE         │ ──▶ │   OUTPUT SURFACES       │
│                  │     │                      │     │                         │
│  filesystem      │     │  collect              │     │  cnos.read(...)         │
│  dotenv          │     │  namespace            │     │  cnos.require(...)      │
│  process env     │     │  merge & resolve      │     │  cnos.toEnv()           │
│  CLI args        │     │  validate             │     │  cnos.toPublicEnv()     │
│  (future: remote │     │  produce resolved     │     │  CLI read/inspect/define│
│   github, kube)  │     │    config graph       │     │  cnos run -- <cmd>      │
└─────────────────┘     └──────────────────────┘     │  framework projections  │
                                                      └─────────────────────────┘
```

### 6.2 Package Structure

```
packages/
  cnos-core/    → orchestrator, plugin contracts, resolution engine
  cnos/         → batteries-included entry with default v1 plugins
  cnos-cli/     → CLI commands, developer workflow surface
```

#### `@kitsy/cnos-core`
Owns: plugin interfaces, manifest loading, profile resolution, namespace assignment, merge/resolution pipeline, validation pipeline, inspection/provenance pipeline, export/projection pipeline.

#### `@kitsy/cnos`
Owns: batteries-included developer entry, `createCnos(...)` entrypoint, default v1 plugins wired together, re-exports of runtime types.

#### `@kitsy/cnos-cli`
Owns: command parsing, project manifest loading, runtime instantiation, CLI commands (`init`, `read`, `define`, `inspect`, `validate`, `export`, `run`, `diff`, `doctor`).

---

## 7. Core Domain Model

### 7.1 Types

```ts
// --- Primitives ---

type LogicalKey = string;
// "value.inventory.db.host", "secret.inventory.db.password", "meta.profile"

type NamespaceName = "value" | "secret" | "meta";
// Note: "public" is not a namespace. It is a promotion/projection concern.

// --- Config Entry (output of a loader plugin) ---

interface ConfigEntry {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  sourceId: string;        // e.g. "filesystem-values", "dotenv", "cli-args"
  pluginId: string;        // loader plugin that produced this
  profile?: string;        // profile context if applicable
  origin?: {
    file?: string;
    line?: number;
    envVar?: string;
    cliArg?: string;
  };
  metadata?: Record<string, unknown>;
}

// --- Resolved Entry (output of resolution) ---

interface ResolvedEntry {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  winner: ConfigEntry;
  overridden: ConfigEntry[];
}

// --- Resolved Graph (complete resolved config) ---

interface ResolvedGraph {
  entries: Map<LogicalKey, ResolvedEntry>;
  profile: string;
  resolvedAt: string;        // ISO timestamp
  profileSource: string;     // "cli" | "env" | "manifest-default"
}
```

### 7.2 Plugin Contracts

```ts
// --- Base ---
interface CnosPlugin {
  id: string;
  kind: "loader" | "resolver" | "validator" | "exporter" | "inspector";
}

// --- Loader (replaces "reader") ---
interface LoaderPlugin extends CnosPlugin {
  kind: "loader";
  load(context: LoaderContext): Promise<ConfigEntry[]>;
}

// --- Resolver ---
interface ResolverPlugin extends CnosPlugin {
  kind: "resolver";
  resolve(entries: ConfigEntry[], context: ResolverContext): Promise<ResolvedGraph>;
}

// --- Validator ---
interface ValidatorPlugin extends CnosPlugin {
  kind: "validator";
  validate(graph: ResolvedGraph, context: ValidationContext): Promise<ValidationResult>;
}

// --- Exporter ---
interface ExporterPlugin extends CnosPlugin {
  kind: "exporter";
  export(graph: ResolvedGraph, context: ExportContext): Promise<ExportResult>;
}

// --- Inspector ---
interface InspectorPlugin extends CnosPlugin {
  kind: "inspector";
  inspect(key: LogicalKey, graph: ResolvedGraph, context: InspectContext): Promise<InspectResult>;
}
```

**Note on naming:** Plugins that ingest config are called **loaders**, not "readers". "Reader" is reserved for the output/consumer side (`cnos.read(...)`). This avoids the ambiguity of "reader" meaning both "thing that reads sources" and "thing the app uses to read config."

### 7.3 Context Objects

```ts
interface LoaderContext {
  manifestConfig: Record<string, unknown>;  // plugin-specific config from manifest
  profile: string;
  profileChain: string[];                   // ordered list of activated profiles
  cnosRoot: string;                         // absolute path to cnos/ directory
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
}

interface ResolverContext {
  manifest: NormalizedManifest;
  profile: string;
  profileChain: string[];
  precedenceOrder: string[];  // ordered loader IDs, lowest to highest
}

interface ValidationContext {
  manifest: NormalizedManifest;
  schema?: Record<LogicalKey, SchemaRule>;
}

interface ExportContext {
  manifest: NormalizedManifest;
  promotions: PromotionRule[];  // which value.* keys are promoted to public
  frameworkPrefixes?: string[]; // e.g. ["NEXT_PUBLIC_", "VITE_"]
}

interface InspectContext {
  manifest: NormalizedManifest;
}
```

---

## 8. Root Manifest

CNOS root manifest file: `cnos/cnos.yml`

### 8.1 Complete v1 Schema

```yaml
version: 1

project:
  name: my-service

# --- Profile resolution ---
profiles:
  default: local
  resolveFrom:
    - cli.profile       # --profile=<name>
    - env.CNOS_PROFILE  # CNOS_PROFILE env var
    - default           # fallback to profiles.default

# --- Plugin registration ---
plugins:
  loaders:
    - filesystem-values
    - filesystem-secrets
    - dotenv
    - process-env
    - cli-args
  resolver: profile-aware          # single resolver, not a list
  validators:
    - basic-schema
  exporters:
    - env
    - public-env
  inspectors:
    - provenance

# --- Source configuration ---
sources:
  filesystem-values:
    root: ./values
    format: yaml

  filesystem-secrets:
    root: ./secrets
    format: yaml

  dotenv:
    root: ./env

# --- Resolution ---
resolution:
  precedence:                       # lowest to highest priority
    - filesystem-values
    - filesystem-secrets
    - dotenv
    - process-env
    - cli-args
  arrayPolicy: replace              # replace | append | unique-append

# --- Env mapping ---
envMapping:
  # Convention-based auto-mapping for process env and dotenv
  convention: SCREAMING_SNAKE       # value.server.port → SERVER_PORT
  # Explicit overrides (take priority over convention)
  explicit:
    DATABASE_HOST: value.inventory.db.host
    DATABASE_PASSWORD: secret.inventory.db.password
    NEXT_PUBLIC_API_BASE_URL: value.api.baseUrl

# --- Public promotion ---
# Which value.* keys are promoted to public surfaces.
# secret.* can NEVER be promoted.
public:
  promote:
    - value.api.baseUrl
    - value.api.version
    - value.app.name
  # Framework-specific prefix projections
  frameworks:
    next: NEXT_PUBLIC_
    vite: VITE_
    nuxt: NUXT_PUBLIC_

# --- Write policy for CLI define ---
writePolicy:
  define:
    defaultProfile: local
    targets:
      value: ./values/{profile}/app.yml
      secret: ./secrets/{profile}/app.yml

# --- Schema (optional) ---
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

# --- Monorepo (v1 placeholder, full support deferred) ---
# workspaces:
#   packages/api:
#     overlay: ./packages/api/cnos/
#   packages/web:
#     overlay: ./packages/web/cnos/
```

### 8.2 Key Design Decisions in the Manifest

**Single resolver, not a list.** v1 ships one resolver (`profile-aware`) that handles both the simple case (no profiles defined = flat merge) and the complex case (profile inheritance + precedence). There is no separate "simple resolver." If no profiles are defined, the profile-aware resolver degrades to flat precedence merge — same behavior, zero additional code paths.

**Convention-based env mapping.** The `envMapping.convention` field enables auto-mapping from logical keys to env var names using a naming convention. This avoids requiring 50 explicit mapping lines. Explicit entries in `envMapping.explicit` override the convention for specific vars.

**Public as promotion.** The `public.promote` list declares which `value.*` keys are projected to public surfaces. The `public.frameworks` map defines prefix projections per framework. This replaces the previous `public.*` namespace entirely.

---

## 9. Filesystem Convention

### 9.1 Starter Structure

```
cnos/
  cnos.yml                    # root manifest

  profiles/
    profile.yml               # profile definitions
    local.yml
    stage.yml
    prod.yml

  values/
    base/
      app.yml                 # shared base values
    local/
      app.yml                 # local overrides
    stage/
      app.yml
    prod/
      app.yml

  secrets/
    local/
      app.yml                 # local secrets
    stage/
      app.yml
    prod/
      app.yml

  env/
    .env                      # base env
    .env.local
    .env.stage
    .env.prod
```

### 9.2 Namespace-to-Directory Mapping

This is explicit and deterministic:

| Source root | Namespace produced | Loader plugin |
|-------------|-------------------|---------------|
| `values/` | `value.*` | `filesystem-values` |
| `secrets/` | `secret.*` | `filesystem-secrets` |
| `env/` | Mapped per `envMapping` | `dotenv` |

Files under `values/` **always** produce `value.*` keys. There is no magic file-name-based namespace switching. If `values/local/app.yml` contains `{ api: { baseUrl: "http://localhost:3000" } }`, it produces `value.api.baseUrl`. Whether that key is promoted to public is determined by the `public.promote` list in the manifest — not by file naming.

Files under `secrets/` **always** produce `secret.*` keys.

---

## 10. Profile Model

### 10.1 Profile Definition

Each profile declares what it extends and what layers it activates:

```yaml
# cnos/profiles/local.yml
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

```yaml
# cnos/profiles/prod.yml
name: prod
extends: [base]

activate:
  values:
    - base
    - prod
  secrets:
    - prod
  envFiles:
    - .env
    - .env.prod
```

### 10.2 Profile Resolution Order

How the active profile is determined (first match wins):

1. CLI flag: `--profile=stage`
2. Environment variable: `CNOS_PROFILE=stage`
3. Manifest default: `profiles.default: local`

### 10.3 Inheritance Rules

- Parent profiles are expanded before child profiles.
- Inheritance cycles are detected and produce a hard error.
- Profile activation order is deterministic: parents first, then child, in declaration order.
- The expanded profile chain becomes the `profileChain` in context objects.

---

## 11. Loader Plugins (v1)

### 11.1 `filesystem-values`

- Reads YAML files from the configured `values/` root.
- Flattens nested YAML into logical keys under `value.*`.
- Only reads directories activated by the profile chain.
- Preserves provenance: file path at minimum.

Example: `values/local/app.yml` containing `{ server: { port: 3000 } }` produces `value.server.port = 3000` with origin `{ file: "cnos/values/local/app.yml" }`.

### 11.2 `filesystem-secrets`

- Reads YAML files from the configured `secrets/` root.
- Flattens into `secret.*` keys.
- Only reads directories activated by the profile chain.

### 11.3 `dotenv`

- Reads `.env` files activated by the profile chain.
- Maps env var names to logical keys through the `envMapping` config.
- Convention mapping: `DATABASE_HOST` → looks up explicit mapping first, then applies convention.
- If a var has no mapping (explicit or convention-derived), it is ignored (explicit loading, not magical).

### 11.4 `process-env`

- Reads `process.env` at runtime.
- Maps env vars to logical keys through the same `envMapping` config.
- Same mapping logic as dotenv loader: explicit first, convention second, unmapped vars ignored.

### 11.5 `cli-args`

- Reads command-line arguments.
- Supports direct logical key overrides:
  - `--value.server.port=8080`
  - `--secret.inventory.db.password=...`
  - `--profile=stage`
- Highest precedence by default.

---

## 12. Resolution

### 12.1 Single Resolver: `profile-aware`

v1 ships one resolver that handles all cases:

1. Determine active profile (§10.2).
2. Expand profile chain via inheritance.
3. Collect `ConfigEntry[]` from all loaders, tagged with their source.
4. Apply precedence order from `resolution.precedence` (lowest to highest):
   - `filesystem-values` / `filesystem-secrets` (profile layer order: parents first)
   - `dotenv`
   - `process-env`
   - `cli-args`
5. For each logical key, determine winner by last-writer-wins with precedence.
6. Merge behavior:
   - **Objects/maps:** deep merge.
   - **Scalars:** override by higher-precedence entry.
   - **Arrays:** policy from `resolution.arrayPolicy` (default: `replace`).
7. Produce `ResolvedGraph` with full override chains.

If no profiles are defined, the resolver simply skips steps 1-2 and proceeds with flat precedence — no separate code path needed.

### 12.2 Missing Key Behavior

- `read(key)` → returns `undefined` if absent.
- `require(key)` → throws `CnosKeyNotFoundError` if absent.
- `readOr(key, fallback)` → returns fallback if absent.

---

## 13. Validation

### 13.1 Built-in Schema Validator

```ts
interface SchemaRule {
  type?: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  enum?: unknown[];
  pattern?: string;     // regex pattern for strings
  default?: unknown;
}
```

### 13.2 Behavior

- Validates against rules declared in `schema:` section of manifest.
- Reports **all** failures, not just the first.
- Applies `default` values before final graph output if declared.
- **Never** invents defaults for `secret.*` keys unless explicitly declared in schema.
- Validates that no `secret.*` key appears in `public.promote`.

### 13.3 Public Safety Validation

This runs as part of validation, not as a separate pass:

- `public.promote` must only contain `value.*` keys.
- Any `secret.*` key in `public.promote` is a hard validation error.
- `toPublicEnv()` double-checks at export time: if a non-`value.*` key somehow got promoted, it throws.

---

## 14. Inspection / Provenance

### 14.1 Inspect Result

```ts
interface InspectResult {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  profile: string;
  profileSource: string;    // "cli" | "env" | "manifest-default"
  winner: {
    sourceId: string;
    pluginId: string;
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

### 14.2 What Inspect Answers

- What is the final value?
- Which source won?
- Which profile was active?
- How was the profile determined?
- Which lower-priority entries were overridden, and what were their values?

---

## 15. Export / Projection

### 15.1 `toEnv()`

Exports the full resolved graph (minus `meta.*`) as flat env variable map.

Flattening convention: `value.server.port` → `SERVER_PORT` (strips namespace prefix, SCREAMING_SNAKE the rest).

Options:
```ts
interface ToEnvOptions {
  includeNamespaces?: NamespaceName[];  // default: ["value", "secret"]
  excludeNamespaces?: NamespaceName[];
  prefixStyle?: "strip-namespace" | "keep-namespace";
}
```

### 15.2 `toPublicEnv()`

Exports **only** promoted `value.*` keys as env variables, projected with framework prefixes.

```ts
interface ToPublicEnvOptions {
  framework?: "next" | "vite" | "nuxt" | string;  // selects prefix from manifest
  customPrefix?: string;                            // override prefix
}
```

Safety: `toPublicEnv()` reads `public.promote` from manifest, filters the resolved graph to only those keys, verifies none are `secret.*`, and applies the framework prefix projection.

### 15.3 Framework Projection

Given:
```yaml
public:
  promote:
    - value.api.baseUrl
  frameworks:
    next: NEXT_PUBLIC_
    vite: VITE_
```

Then `cnos.toPublicEnv({ framework: "next" })` produces:
```
NEXT_PUBLIC_API_BASE_URL=https://example.com
```

And `cnos.toPublicEnv({ framework: "vite" })` produces:
```
VITE_API_BASE_URL=https://example.com
```

---

## 16. Env Mapping

### 16.1 Convention-Based Auto-Mapping

When `envMapping.convention: SCREAMING_SNAKE` is set:

| Logical key | Env var name |
|-------------|-------------|
| `value.server.port` | `SERVER_PORT` |
| `value.inventory.db.host` | `INVENTORY_DB_HOST` |
| `secret.inventory.db.password` | `SECRET_INVENTORY_DB_PASSWORD` |

The namespace prefix is included for `secret.*` to avoid collisions. For `value.*`, the namespace prefix is stripped.

### 16.2 Explicit Overrides

Explicit entries in `envMapping.explicit` take priority over convention:

```yaml
envMapping:
  convention: SCREAMING_SNAKE
  explicit:
    DATABASE_HOST: value.inventory.db.host     # overrides convention-derived INVENTORY_DB_HOST
    DATABASE_PASSWORD: secret.inventory.db.password
```

### 16.3 Bidirectional

The mapping works in both directions:
- **Env → logical key:** used by `dotenv` and `process-env` loaders when ingesting.
- **Logical key → env:** used by `toEnv()` and `toPublicEnv()` when exporting.

---

## 17. Runtime API

### 17.1 Constructor

```ts
interface CreateCnosOptions {
  root?: string;                                    // path to cnos/ directory, default cwd
  profile?: string;                                 // override active profile
  plugins?: CnosPlugin[];                           // additional/override plugins
  cliArgs?: string[];                               // CLI arg overrides
  processEnv?: Record<string, string | undefined>;  // override process.env (useful for testing)
}
```

### 17.2 Main Runtime

```ts
interface CnosRuntime {
  // Core reads
  read<T = unknown>(key: LogicalKey): T | undefined;
  require<T = unknown>(key: LogicalKey): T;
  readOr<T>(key: LogicalKey, fallback: T): T;

  // Convenience helpers (internally prepend namespace)
  value<T = unknown>(path: string): T | undefined;    // value("server.port") → read("value.server.port")
  secret<T = unknown>(path: string): T | undefined;
  meta<T = unknown>(path: string): T | undefined;

  // Inspection
  inspect(key: LogicalKey): InspectResult;

  // Projection
  toObject(): Record<string, unknown>;
  toNamespace(namespace: NamespaceName): Record<string, unknown>;
  toEnv(options?: ToEnvOptions): Record<string, string>;
  toPublicEnv(options?: ToPublicEnvOptions): Record<string, string>;

  // Graph access (advanced)
  readonly graph: ResolvedGraph;
}
```

### 17.3 Usage Example

```ts
import { createCnos } from "@kitsy/cnos";

const cnos = await createCnos({ root: process.cwd() });

// Read values
const dbHost = cnos.require("value.inventory.db.host");
const dbPass = cnos.require("secret.inventory.db.password");
const port = cnos.readOr("value.server.port", 3000);

// Convenience
const apiBase = cnos.value("api.baseUrl");

// Debug
const info = cnos.inspect("value.inventory.db.host");
console.log(info.winner.origin?.file);

// Export
const publicEnv = cnos.toPublicEnv({ framework: "next" });
const allEnv = cnos.toEnv();
```

---

## 18. CLI Specification

### 18.1 `cnos init`

Creates:
- Starter `cnos/` directory with manifest, profile files, sample values/secrets/env files.
- Generates `.gitignore` entries: `cnos/secrets/` and `cnos/env/.env.*.local` are gitignored.
- Optionally detects existing `.env` files and offers migration.

### 18.2 `cnos read <logical-key>`

Resolves and prints a single key's value.

```bash
cnos read value.inventory.db.host
# → 127.0.0.1

cnos read value.inventory.db.host --profile stage
# → stage-db.example.com

cnos read value.inventory.db.host --json
# → { "key": "value.inventory.db.host", "value": "127.0.0.1" }
```

### 18.3 `cnos value <path>` / `cnos secret <path>`

Convenience aliases:

```bash
cnos value "inventory.db.host"     # equivalent to: cnos read value.inventory.db.host
cnos secret "inventory.db.password" # equivalent to: cnos read secret.inventory.db.password
```

### 18.4 `cnos define <namespace> <path> <value>`

Writes a config value to the correct file, determined by write policy.

```bash
cnos define value "server.port" "3000"
cnos define secret "inventory.db.password" "s3cr3t"
cnos define value "server.port" "8080" --profile stage
cnos define value "server.port" "8080" --file ./values/custom/app.yml   # explicit override
```

Requirements:
- Target file chosen by `writePolicy.define.targets` pattern.
- Profile resolved before write (uses same profile resolution as read).
- Creates target file if missing.
- Deep-writes YAML paths (e.g., `server.port` → `{ server: { port: "3000" } }`).
- Preserves existing file content where possible.
- Prevents writing `secret.*` into `values/` path and vice versa.
- Values are stored as strings; schema validation coerces types at read time.

### 18.5 `cnos inspect <logical-key>`

Shows provenance in human-readable format:

```bash
cnos inspect value.inventory.db.host
# Key:       value.inventory.db.host
# Value:     127.0.0.1
# Namespace: value
# Profile:   local (from: manifest-default)
# Winner:    filesystem-values
#   File:    cnos/values/local/app.yml
# Overridden:
#   [1] filesystem-values → "10.0.0.1"
#       File: cnos/values/base/app.yml

cnos inspect value.inventory.db.host --json
# → structured InspectResult JSON
```

### 18.6 `cnos validate`

Runs all validation plugins. Reports all errors.

```bash
cnos validate
# ✓ Schema valid
# ✓ No secret keys in public promotions
# ✓ Profile graph acyclic
# ✓ All required keys present

cnos validate --profile stage
```

### 18.7 `cnos export env`

Exports flat env output.

```bash
cnos export env                           # all non-meta namespaces
cnos export env --public                  # only promoted public keys
cnos export env --public --framework next # with NEXT_PUBLIC_ prefix
cnos export env --profile stage
cnos export env --json                    # JSON output
cnos export env > .env.generated          # pipe to file
```

### 18.8 `cnos run -- <command>`

Resolves config, exports as env vars, spawns child process.

```bash
cnos run -- node server.js
cnos run --profile stage -- node server.js
cnos run --public -- npx next build       # only public vars injected
```

This is the **lowest-friction adoption path**. A team can use `cnos run` with zero code changes — the app reads `process.env` as usual, CNOS just ensures the right values are there.

### 18.9 `cnos diff`

Compares resolved config between two profiles.

```bash
cnos diff --from local --to stage
# value.server.port:       3000  →  8080
# value.inventory.db.host: 127.0.0.1  →  stage-db.example.com
# secret.inventory.db.password: ****  →  ****  (changed)

cnos diff --from local --to stage --json
```

### 18.10 `cnos doctor`

Runs system health checks:

- Manifest is valid and loadable.
- Profile graph is acyclic.
- Source roots exist or are creatable.
- No `secret.*` keys in `public.promote`.
- Required keys (from schema) are present.
- `cnos/secrets/` is in `.gitignore` (warning if not).
- No orphaned profile references.
- Env mapping has no collisions (two logical keys → same env var).

---

## 19. Write Policy

### 19.1 Manifest Declaration

```yaml
writePolicy:
  define:
    defaultProfile: local
    targets:
      value: ./values/{profile}/app.yml
      secret: ./secrets/{profile}/app.yml
```

### 19.2 Resolution

Given `cnos define value "server.port" "3000"`:

1. Determine profile: `--profile` flag, else `writePolicy.define.defaultProfile`.
2. Look up target pattern: `writePolicy.define.targets.value` → `./values/{profile}/app.yml`.
3. Substitute: `./values/local/app.yml`.
4. Resolve relative to `cnos/` root.
5. Create file if missing.
6. Deep-write YAML path: `server.port: "3000"`.

### 19.3 Safety Guardrails

- Cannot write `secret.*` into a path under `values/`.
- Cannot write `value.*` into a path under `secrets/`.
- Profile must resolve before write.
- If `--file` is provided, it overrides the pattern but namespace safety still applies.

---

## 20. Internal Module Layout

### 20.1 `packages/cnos-core/src/`

```
src/
  index.ts                    # public exports
  types/
    core.ts                   # LogicalKey, NamespaceName, ConfigEntry, ResolvedEntry, ResolvedGraph
    plugin.ts                 # CnosPlugin, LoaderPlugin, ResolverPlugin, etc.
    manifest.ts               # manifest types, NormalizedManifest
    profile.ts                # profile types
    schema.ts                 # SchemaRule, ValidationResult
    export.ts                 # ToEnvOptions, ToPublicEnvOptions, PromotionRule
  manifest/
    loadManifest.ts           # read and parse cnos.yml
    normalizeManifest.ts      # validate and normalize
  profiles/
    resolveActiveProfile.ts   # determine which profile is active
    expandProfileChain.ts     # expand inheritance, detect cycles
  orchestrator/
    createCnos.ts             # main entry point
    runtime.ts                # CnosRuntime implementation
    pipeline.ts               # load → resolve → validate → ready
  loaders/
    filesystemValues.ts
    filesystemSecrets.ts
    dotenv.ts
    processEnv.ts
    cliArgs.ts
  resolvers/
    profileAwareResolver.ts   # the single v1 resolver
  validators/
    basicSchema.ts
    publicSafety.ts           # validates promotion rules
  exporters/
    toEnv.ts
    toPublicEnv.ts
  inspectors/
    provenance.ts
  utils/
    path.ts
    flatten.ts                # nested YAML → flat logical keys
    deepMerge.ts
    yaml.ts
    envNaming.ts              # convention-based env name mapping
```

### 20.2 `packages/cnos/src/`

```
src/
  index.ts                    # createCnos with default plugins, re-exports
  defaults.ts                 # default plugin registry
```

### 20.3 `packages/cnos-cli/src/`

```
src/
  index.ts                    # CLI entry
  commands/
    init.ts
    read.ts
    define.ts
    inspect.ts
    validate.ts
    export.ts
    run.ts
    diff.ts
    doctor.ts
  output/
    format.ts                 # human-readable formatting
    json.ts                   # JSON output formatting
```

---

## 21. Testing Requirements

### 21.1 Unit Tests

- Manifest loading and normalization (valid, invalid, missing fields).
- Profile resolution: CLI > env > default precedence.
- Profile chain expansion, including cycle detection.
- Deep merge: objects, scalars, arrays with each policy.
- Namespace assignment: `values/` → `value.*`, `secrets/` → `secret.*`.
- Env mapping: convention-based and explicit, bidirectional.
- Public promotion filtering: only promoted `value.*` keys exported.
- Public safety: `secret.*` in promote list → hard error.
- Write routing: correct file targeting per profile and namespace.
- Schema validation: type, required, enum, pattern, default.
- Meta key population.

### 21.2 Integration Tests

- Starter project with `local`, `stage`, `prod` profiles.
- Full resolution: filesystem + dotenv + process env + CLI args with precedence.
- Inspect/provenance output for a key overridden across multiple sources.
- CLI `define` then runtime `read` round-trip.
- CLI `export env --public --framework next` output.
- `cnos run -- node -e "console.log(process.env.SERVER_PORT)"` with expected value.
- `cnos diff --from local --to stage` output.
- Invalid schema → validation failures reported.
- Inheritance cycle → hard error.
- Secret in promote list → hard error.

### 21.3 Golden Tests

Snapshot-based tests for:
- CLI human-readable inspect output.
- Exported env maps.
- Diff output.
- Doctor output.

---

## 22. Scope Boundaries

### 22.1 In v1

- Core orchestrator with full pipeline.
- All v1 loader plugins (filesystem-values, filesystem-secrets, dotenv, process-env, cli-args).
- Profile-aware resolver.
- Basic schema validator.
- Provenance inspector.
- Env and public-env exporters.
- Full CLI: init, read, value, secret, define, inspect, validate, export, run, diff, doctor.
- Convention-based env mapping.
- Public promotion (not a namespace, a projection).
- Meta namespace with well-known keys.
- `.gitignore` generation for secrets.
- Tests.
- README and starter example.

### 22.2 Deferred Beyond v1

- Remote secret managers (Vault, AWS SSM, etc.).
- Encrypted local secret files.
- Kubernetes-native loader plugin.
- GitHub-based config loader.
- Watch mode / hot reload.
- `cnos codegen` for TypeScript type generation from schema.
- Browser runtime package.
- Language ports (Go, Rust, Python).
- Full monorepo workspace resolution (manifest schema has placeholder).
- Config UI dashboard.
- Advanced policy engine.
- Zod/Joi adapter validators.

---

## 23. Hard Constraints

1. Do **not** hardcode dotenv-only behavior into core.
2. Do **not** let application code care about file layout, env conventions, or source precedence.
3. Do **not** collapse plugin boundaries to reduce file count.
4. Do **not** allow `secret.*` in public promotion or public export. Ever.
5. Do **not** make CLI write targeting nondeterministic.
6. Do **not** couple the manifest model to Node-only assumptions where avoidable.
7. Do **not** bake framework-specific public env rules into core — they are manifest config and exporter options.
8. Do **not** invent unnecessary abstractions beyond what the plugin architecture requires.
9. Prefer correctness, readability, and explicitness over cleverness.

---

## 24. Incremental Delivery Plan

### Phase 1: Core + Filesystem

- Core types and plugin contracts.
- Manifest loader and normalizer.
- `filesystem-values` and `filesystem-secrets` loaders.
- Profile-aware resolver (flat mode only — no inheritance yet).
- Runtime: `read`, `require`, `readOr`.
- Meta namespace population.

### Phase 2: Remaining Loaders + Precedence

- `dotenv`, `process-env`, `cli-args` loaders.
- Convention-based env mapping.
- Full precedence pipeline.
- Inspect/provenance.

### Phase 3: Profiles + Export

- Profile inheritance expansion and cycle detection.
- Profile chain resolution in resolver.
- `toEnv()` and `toPublicEnv()` exporters.
- Public promotion logic.

### Phase 4: CLI

- `init`, `read`, `value`, `secret`, `inspect`, `export` commands.
- `define` with write policy routing.
- `run` command (resolve → export → spawn).
- `diff` command.
- `doctor` command.
- `.gitignore` generation in `init`.

### Phase 5: Validation + Polish

- Basic schema validator.
- Public safety validator.
- Tests (unit, integration, golden).
- README, docs, starter example.

---

## 25. What Makes CNOS Strong

1. **Logical key API** — code reads `value.server.port`, never cares where it came from.
2. **Plugin-based resolution** — loaders ingest, core resolves, exporters project.
3. **CLI define/read** — deterministic write routing means developers never hunt for the right file.
4. **Provenance inspection** — answer "why did this key get this value?" definitively.
5. **Public as promotion** — clean separation without a fake namespace; framework-aware projection.
6. **`cnos run`** — zero-code-change adoption path.
7. **Convention-based env mapping** — bridge from dotenv world without manual mapping drudgery.
8. **Config spectrum** — start with `.env`, grow to profiles/layers/secrets without rewriting app code.
