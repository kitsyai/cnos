# CNOS v1 — Codex Bootstrap Prompt

You are implementing CNOS from a fresh start.

CNOS is an open-source, plugin-based **configuration workflow orchestrator**.

The purpose of CNOS is to let application code read stable logical config keys such as:

- `value.inventory.db.host`
- `secret.inventory.db.password`
- `public.api.baseUrl`

while the actual configuration sources and workflow remain declarative and extensible.

Application code must depend on CNOS, not on raw `.env` conventions, ad hoc YAML loading, shell env assumptions, or framework-specific public env behavior.

---

## Authority and Intent

Use this prompt to bootstrap a clean v1 implementation of:

- `@kitsy/cnos-core`
- `@kitsy/cnos`
- `@kitsy/cnos-cli`

This is a new implementation. There is no legacy compatibility requirement.

The architecture must preserve the long-term product direction:

- config management exists on a spectrum
- one end is simple `.env`, shell env, and CLI args
- the other end can grow toward kube-like declarative config workflows
- CNOS core is the workflow orchestrator
- readers, resolvers, exporters, validators, and inspectors are plugins
- v1 only needs a strong Node/TypeScript wedge, but the architecture must remain extensible

---

## Product Thesis

CNOS is **not** just a dotenv wrapper.

CNOS is a **portable, plugin-based configuration workflow orchestrator** that lets applications read stable logical config keys while the actual sources, precedence rules, profile inheritance, secret handling, and public config export remain declarative and extensible.

Keep this invariant:

> Application code reads logical keys. Plugins decide how config is read, resolved, validated, inspected, and exported.

---

## Package Targets

Create these packages in a pnpm monorepo-style workspace layout if not already present:

- `packages/cnos-core`
- `packages/cnos`
- `packages/cnos-cli`

### Package responsibilities

#### `@kitsy/cnos-core`
Owns:
- plugin interfaces
- manifest loading and normalization
- workflow orchestration
- internal config graph model
- reader pipeline
- resolver pipeline
- validation pipeline
- export pipeline
- inspection/provenance pipeline

#### `@kitsy/cnos`
Owns:
- batteries-included user-facing runtime
- default v1 plugins prewired
- `createCnos(...)` entrypoint
- re-exports of common runtime types

#### `@kitsy/cnos-cli`
Owns:
- CLI commands
- loading CNOS runtime from project root
- reading, defining, inspecting, validating, exporting config

---

## Hard Constraints

1. Do **not** hardcode dotenv-only behavior into core.
2. Do **not** let application code care about file layout, env conventions, or source precedence.
3. Do **not** collapse plugin boundaries just to reduce file count.
4. Do **not** allow any public export of `secret.*`.
5. Do **not** make CLI write targeting nondeterministic.
6. Do **not** couple the manifest model to Node-only assumptions if avoidable.
7. Do **not** bake framework-specific public env rules into core; keep them as export options or future plugins.
8. Do **not** invent unnecessary abstractions beyond what is needed for the plugin architecture.
9. Prefer correctness, readability, and explicitness over cleverness.

---

## v1 Scope

Implement the following in v1:

### Core orchestration
- manifest loading from `cnos/cnos.yml`
- plugin registry
- normalized config entries
- resolved config graph

### Reader plugins
- filesystem values reader
- filesystem secrets reader
- dotenv reader
- process env reader
- CLI args reader

### Resolver plugins
- simple resolver
- inherited/profile-aware resolver

### Validation
- minimal built-in schema validator

### Inspection
- provenance inspector for resolved keys

### Export
- `toEnv()`
- `toPublicEnv()`
- CLI export env/public env

### Runtime API
- `read`
- `require`
- `readOr`
- `inspect`
- `toObject`
- `toNamespace`
- `toEnv`
- `toPublicEnv`

### CLI
- `cnos init`
- `cnos read <logical-key>`
- `cnos value <path>`
- `cnos define <namespace> <path> <value>`
- `cnos inspect <logical-key>`
- `cnos validate`
- `cnos export env`
- `cnos doctor`

---

## Logical Namespaces

Use these namespaces:

- `value.*`
- `secret.*`
- `public.*`
- `meta.*`

Keep physical folders such as `values/` and `secrets/` if needed, but the runtime access model must use singular logical namespaces.

Examples:
- `value.inventory.db.host`
- `secret.inventory.db.password`
- `public.api.baseUrl`

---

## Recommended Starter Filesystem Convention

Assume or scaffold:

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

This is a convention, not the core identity of the system.

---

## Root Manifest Requirements

Support a root manifest at `cnos/cnos.yml` that can express:

- project metadata
- active/default profile selection
- plugin registration
- source declarations
- namespace reader routing
- precedence rules
- write policy for CLI define
- public export rules
- optional schema rules

Implement a readable, explicit manifest schema. It does not need to be over-generalized in v1, but it must preserve plugin-based orchestration.

---

## Core Types

Create clean types/interfaces for:

- `LogicalKey`
- `NamespaceName`
- `ConfigEntry`
- `ResolvedEntry`
- `ResolvedGraph`
- `CnosPlugin`
- `ReaderPlugin`
- `ResolverPlugin`
- `ValidatorPlugin`
- `ExporterPlugin`
- `InspectorPlugin`
- `CnosRuntime`

Design them so they remain portable conceptually beyond TypeScript.

---

## Reader Behavior

### Filesystem values reader
- read YAML files from configured values root
- flatten nested keys into logical keys under `value.*`
- preserve provenance (file path, line if practical later; file path at minimum)

### Filesystem secrets reader
- read YAML files from configured secrets root
- flatten nested keys into logical keys under `secret.*`
- preserve provenance

### Dotenv reader
- read env files activated by profile
- support env mapping from env var names to logical keys
- keep behavior explicit, not magical

### Process env reader
- read from `process.env`
- map env vars to logical keys through manifest-declared mapping and limited sensible defaults

### CLI args reader
- support direct logical overrides such as:
  - `--value.server.port=8080`
  - `--secret.inventory.db.password=...`
  - `--profile=stage`

---

## Resolver Behavior

### Simple resolver
- deep merge objects
- scalar last-writer-wins
- array default policy: replace

### Inherited/profile-aware resolver
- resolve active profile
- expand parent profiles first
- activate values/secrets/env layers from profile definitions
- then apply precedence across reader outputs

Resolution precedence should default to:
1. filesystem/profile layers
2. dotenv
3. process env
4. CLI args

Make precedence explicit and testable.

---

## Validation Rules

Implement a minimal built-in schema validator supporting:
- `type`
- `required`
- `enum`
- `pattern`
- `default`

Allow optional schema definitions in the manifest.

Do not silently invent defaults for secrets unless explicitly configured.

---

## Provenance / Inspect

Implement `inspect()` and CLI `inspect` so a user can answer:

- what is the final value?
- which source won?
- which profile was active?
- which lower-priority entries were overridden?

Return structured data internally and render a human-readable CLI output.

---

## Public Export Safety

This is a hard stop requirement.

- `toPublicEnv()` and CLI public export must only include `public.*`
- `secret.*` must never be exportable through public export
- `value.*` should not leak into public export unless explicitly projected into `public.*`
- fail closed, not open

Add tests for this.

---

## CLI Define Requirements

Support:

```bash
cnos define value "server.port" "3000"
cnos define secret "db.password" "..."
cnos define public "api.baseUrl" "https://example.com"
```

Requirements:
- do not force the developer to manually locate the correct file
- route writes through manifest-declared write policy
- resolve profile-aware write target
- create target file if missing
- deep-write YAML paths
- preserve existing structure where possible
- support `--profile`
- prevent namespace/file boundary violations

Example write policy:

```yaml
writePolicy:
  define:
    defaultProfile: local
    targets:
      value: ./values/{profile}/app.yml
      secret: ./secrets/{profile}/app.yml
      public: ./values/{profile}/public.yml
```

---

## Runtime API Shape

Implement an ergonomic runtime like:

```ts
const cnos = await createCnos({ root: process.cwd() });

cnos.read("value.inventory.db.host");
cnos.require("secret.inventory.db.password");
cnos.readOr("value.server.host", "127.0.0.1");
cnos.inspect("value.inventory.db.host");
cnos.toObject();
cnos.toNamespace("value");
cnos.toEnv();
cnos.toPublicEnv();
```

Optional helpers:
```ts
cnos.value("inventory.db.host");
cnos.secret("inventory.db.password");
cnos.public("api.baseUrl");
```

---

## Internal Module Structure

Use a structure roughly like:

```text
packages/cnos-core/src/
  index.ts
  types/
  manifest/
  profiles/
  orchestrator/
  readers/
  resolvers/
  validators/
  exporters/
  inspectors/
  utils/
```

Keep modules small and explicit.

---

## Testing Requirements

Add tests for:

- manifest loading and normalization
- profile selection precedence
- inheritance cycle detection
- filesystem reading
- dotenv reading
- process env reading
- CLI arg overrides
- deep merge semantics
- inspect/provenance behavior
- public export safety
- CLI define write routing
- schema validation failures
- integration example covering local/stage/prod

Prefer a mix of unit tests and integration tests.

---

## Developer Experience Requirements

The result should feel good in both cases:

### Simple app
A developer using only `.env` can adopt CNOS without pain.

### Growing app or monorepo
A developer can add profile layering, secrets separation, public export, and inspection without changing app code patterns.

---

## Deliverables

Produce:

1. package scaffolding for `cnos-core`, `cnos`, `cnos-cli`
2. initial manifest model
3. plugin interfaces
4. default v1 plugins
5. runtime API implementation
6. CLI implementation
7. tests
8. starter example config tree
9. concise README/docs for local development

---

## Implementation Style

- keep the code readable and production-oriented
- prefer explicit interfaces and small focused modules
- annotate non-obvious behavior with comments
- add reasonable error messages
- avoid over-engineering
- preserve future plugin portability

When making tradeoffs, choose the option that best preserves:

1. logical key API stability
2. plugin-based workflow orchestration
3. deterministic behavior
4. safety around public vs secret config
