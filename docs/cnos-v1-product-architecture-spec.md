# CNOS v1 — Product and Architecture Specification

**Project:** `@kitsy/cnos`  
**Core package:** `@kitsy/cnos-core`  
**CLI package:** `@kitsy/cnos-cli`  
**Status:** Draft v1 for architecture review  
**License intent:** Open source

---

## 1. Executive Summary

Configuration management is a recurring systems problem across applications, monorepos, frontends, services, CI/CD pipelines, and infrastructure workflows.

At one extreme of the spectrum are declarative systems such as Kubernetes, where configuration becomes the control plane and nearly everything is modeled as config. At the other extreme are simple application setups that rely on `.env` files, shell variables, and command-line arguments. Most real-world systems live somewhere in between, and as products grow, they often need to evolve across that spectrum without rewriting their application code around each new config mechanism.

**CNOS** is intended to solve that problem.

CNOS is a **configuration workflow orchestrator**. Application code reads stable logical config keys, while CNOS orchestrates how config is read, resolved, merged, validated, exported, and projected across different environments and surfaces.

The core idea is:

> **Code depends on CNOS, not on raw files, env conventions, or platform-specific lookup logic.**

So instead of code directly assuming `.env`, YAML files, shell variables, or framework-specific public env patterns, the code reads logical keys such as:

- `value.inventory.db.host`
- `secret.inventory.db.password`
- `public.api.baseUrl`

CNOS then decides, through plugins and declarative workflow configuration, where those values come from and how they are resolved.

---

## 2. Problem Statement

### 2.1 The Current Configuration Space

Across apps and systems, configuration usually gets scattered across multiple incompatible mechanisms:

- `.env`
- `.env.local`, `.env.stage`, `.env.prod`
- shell environment variables
- command-line arguments
- YAML or JSON files
- per-environment folders
- CI/CD injected variables
- frontend public env conventions
- secret files or secret stores
- app-specific conventions embedded inside code

This creates several recurring problems:

1. **Configuration source sprawl**  
   Values live in many places, with no single logical model.

2. **Unclear precedence**  
   Teams do not always know whether file config, env vars, or CLI args win.

3. **Convention lock-in**  
   Application code often hardcodes one pattern, making migration painful.

4. **Weak separation between value, secret, and public config**  
   Public-safe values and secrets often get mixed or leak through build tooling.

5. **Poor debuggability**  
   It is hard to answer: “why did this key resolve to this value?”

6. **Frontend/backend divergence**  
   Server apps, browser apps, build-time surfaces, and runtime surfaces all behave differently.

7. **Monorepo inconsistency**  
   Each app or package often invents its own config conventions.

8. **Scaling friction**  
   Teams start with `.env`, then later need layered config, profile inheritance, secret providers, or kube-like declarative workflows. The codebase then needs ad hoc migration.

### 2.2 The Architectural Gap

The gap is that most codebases do not separate:

- the **logical config model** that application code should depend on
- from the **physical config sources** where values are stored
- and from the **resolution workflow** that determines precedence and final values

These concerns get mixed together.

### 2.3 The Opportunity

A portable, plugin-based configuration workflow layer can let systems start simply and grow toward more complex configuration ecosystems without changing how application code consumes config.

---

## 3. Vision

CNOS should support the **full config spectrum over time**:

- **Simple end:** `.env`, shell env, CLI args, local files
- **Middle:** layered profiles, env-specific overrides, public/private separation, monorepo overlays
- **Advanced end:** richer declarative config workflows, external stores, infrastructure-style config orchestration, and eventually kube-like plugins

CNOS should not try to solve the entire spectrum in v1. But the architecture must be capable of growing across that spectrum **without requiring a redesign of the programming model**.

That means:

- application code keeps reading config by stable keys
- CNOS remains the orchestrator
- plugins extend how config is read and resolved
- conventions remain declarative rather than hardcoded into application code

---

## 4. Product Thesis

**CNOS is a portable, plugin-based configuration workflow orchestrator that lets applications read stable logical config keys while the actual sources, precedence rules, profile inheritance, secret handling, and public config export remain declarative and extensible.**

Shorter form:

> **Write code against config keys, not config sources.**

---

## 5. Product Positioning

CNOS is **not**:

- a secret vault by itself
- a deployment system
- a Kubernetes replacement
- a framework-specific env helper only
- a raw file parser only

CNOS **is**:

- a core configuration workflow orchestrator
- a plugin host for config reading and resolution strategies
- a stable logical API for application config access
- a bridge between simple dotenv-style workflows and richer multi-layer config systems
- a portable model that can later be implemented in other languages

---

## 6. Design Principles

### 6.1 Stable logical key access
Application code should read config via logical keys and should not care where a value came from.

### 6.2 Separation of concerns
Storage, resolution, validation, and export should be separate concerns.

### 6.3 Plugin-based growth
Readers, resolvers, exporters, schema validators, and advanced platform integrations should be pluggable.

### 6.4 Convention-as-config
Conventions such as profile chains, precedence orders, env mappings, and public export rules should be represented declaratively rather than hardcoded into app code.

### 6.5 Provenance-first debugging
A resolved config value should be inspectable: which source won, what got overridden, and why.

### 6.6 Public and secret separation
`public.*` must be explicitly exportable; `secret.*` must never leak into client/public surfaces.

### 6.7 Simple-first adoption
A `.env`-using app should be able to adopt CNOS incrementally.

### 6.8 Cross-surface support
Build-time, runtime, server-side, and client-side readers should all fit the same logical model.

### 6.9 Cross-language portability
The config model should not be Node-only, even though v1 starts in TypeScript/Node.

---

## 7. Refined Core Mental Model

CNOS should operate on **logical namespaces**.

Recommended logical namespaces:

- `value.*` — non-secret configuration values
- `secret.*` — sensitive configuration values
- `public.*` — client-safe configuration values
- `meta.*` — metadata, provenance, and runtime resolution context

Examples:

- `value.inventory.db.host`
- `secret.inventory.db.password`
- `public.api.baseUrl`

The physical storage layout can still use folders such as `values/` and `secrets/`, but the API should use singular logical namespaces.

---

## 8. Core Architecture

## 8.1 Package Direction

### `@kitsy/cnos-core`
The core workflow orchestrator.

Responsibilities:
- load CNOS workflow config
- register plugins
- execute config read workflow
- execute resolution workflow
- provide inspection/provenance
- expose stable runtime API
- coordinate export/projection pipelines

### `@kitsy/cnos-cli`
Developer CLI for reading, defining, inspecting, validating, exporting, and editing config.

### `@kitsy/cnos`
User-facing package entry point, potentially re-exporting the most common runtime interfaces from `@kitsy/cnos-core` plus default plugins.

A possible shape:

- `@kitsy/cnos-core` → orchestrator and contracts
- `@kitsy/cnos` → batteries-included package with default v1 plugins
- `@kitsy/cnos-cli` → CLI

---

## 9. Plugin Architecture

This is central to the long-term design.

CNOS is not a single hardcoded resolver. It is an orchestrator of configuration workflow stages.

### 9.1 Plugin Categories

#### A. Reader plugins
Read physical config sources into a normalized internal representation.

Examples:
- filesystem reader
- dotenv reader
- process env reader
- command-line args reader
- secret reader
- kube reader later
- remote provider readers later

#### B. Resolver plugins
Resolve and merge normalized config layers into final config.

Examples:
- simple resolver
- layered/inherited resolver
- profile-aware resolver
- precedence resolver
- kube-style resolver later

#### C. Exporter / projector plugins
Project resolved config outward.

Examples:
- env exporter
- public env exporter
- generated module exporter
- framework-specific exporters later

#### D. Validator plugins
Validate config against rules or schemas.

Examples:
- basic schema validator
- zod adapter later
- policy validator later

#### E. Inspector plugins
Provide provenance and debugging metadata.

Examples:
- key provenance inspector
- profile diff inspector
- conflict reporter

### 9.2 v1 Plugin Strategy

For v1, CNOS can ship with a small plugin set that completes the end-to-end workflow.

#### Reader plugins for v1
- **filesystem reader plugin** for structured config files
- **secrets reader plugin** for secrets config files
- **dotenv reader plugin**
- **process env reader plugin**
- **CLI args reader plugin**

#### Resolver plugins for v1
- **simple resolver** for direct last-writer-wins merges
- **inherited/profile resolver** for layered profile-based resolution

#### Export plugins for v1
- **env export plugin**
- **public export plugin**

#### Inspector plugins for v1
- **inspect key provenance**
- **show override chain**

This architecture keeps the system extensible. Later, more advanced plugins can be added without changing the core programming model.

---

## 10. The Configuration Spectrum

CNOS should explicitly model configuration management as a spectrum.

### 10.1 Simple end
For simple apps:
- `.env`
- `.env.local`
- shell env
- CLI args
- maybe one or two YAML files

CNOS should feel like an easy upgrade from dotenv.

### 10.2 Middle of the spectrum
For growing systems:
- multiple environments
- layered profile inheritance
- shared base + app overrides
- separate secrets handling
- frontend-safe public config export
- monorepo config overlays

### 10.3 Advanced end
For more complex systems:
- richer declarative config graphs
- infrastructure-like config orchestration
- kube-like config plugins
- remote stores
- runtime injectors
- config policy and audit systems

The crucial point is:

> **CNOS core should not encode only the simple end. It should orchestrate plugins such that the full spectrum remains supportable as the system evolves.**

---

## 11. Filesystem and Workspace Model

A recommended starter structure:

```text
cnos/
  cnos.yml

  profiles/
    profile.yml
    local.yml
    stage.yml
    prod.yml
    prod-us-west-1.yml
    cust.yml

  values/
    base/
      app.yml
      inventory.yml
    local/
      app.yml
      inventory.yml
    stage/
      app.yml
    prod/
      app.yml

  secrets/
    local/
      inventory.yml
    stage/
      inventory.yml
    prod/
      inventory.yml

  env/
    .env
    .env.local
    .env.stage
    .env.prod
```

This can later be extended for:
- app-specific overlays
- monorepo workspaces
- custom plugins

---

## 12. Root Workflow Manifest

Use a root manifest such as `cnos.yml` to declare orchestration.

Illustrative example:

```yaml
version: 1

project:
  name: inventory-service

profiles:
  default: local
  resolver:
    from:
      - cli.profile
      - env.CNOS_PROFILE
      - file: profiles/profile.yml
      - default: local

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

sources:
  filesystemValues:
    root: ./values
    format: yaml

  filesystemSecrets:
    root: ./secrets
    format: yaml

  dotenv:
    root: ./env

resolution:
  precedence:
    - profile-files
    - dotenv
    - shell
    - cli

  namespaces:
    value:
      readers: [filesystem-values, dotenv, process-env, cli-args]
    secret:
      readers: [filesystem-secrets, dotenv, process-env, cli-args]
    public:
      readers: [filesystem-values, dotenv, process-env, cli-args]

export:
  public:
    fromNamespaces: [public]
    allowedPrefixes: [PUBLIC_, NEXT_PUBLIC_, VITE_]
```

The exact syntax can evolve, but the shape matters:
- plugin registration
- source declaration
- resolution workflow
- export rules
- profile selection

---

## 13. Profile Model

Profiles should be modeled declaratively.

A profile should answer:
- what it extends
- what value layers it activates
- what secret layers it activates
- what env files it includes

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

Another example:

```yaml
name: prod-us-west-1
extends: [base, prod]

activate:
  values:
    - base
    - prod
    - prod-us-west-1
  secrets:
    - prod
    - prod-us-west-1
  envFiles:
    - .env
    - .env.prod
    - .env.prod-us-west-1
```

This is better than baking environment naming conventions into application code.

---

## 14. Resolution Semantics

Resolution should be explicit and deterministic.

### 14.1 Merge defaults
- objects/maps: deep merge
- scalars: last writer wins
- arrays: configurable policy
  - replace
  - append
  - unique-append

### 14.2 Precedence order
Illustrative default from lowest to highest:
1. base/profile file values
2. env file projections
3. process/shell env
4. CLI args

### 14.3 Missing key behavior
- `read(key)` → returns undefined if absent
- `require(key)` → throws if absent
- `readOr(key, fallback)` → returns fallback if absent

### 14.4 Provenance
Each resolved key should support inspection:
- final value
- source plugin
- source file
- profile context
- override chain

---

## 15. Runtime API Proposal

Illustrative TypeScript shape:

```ts
import { createCnos } from "@kitsy/cnos";

const cnos = await createCnos({
  root: process.cwd(),
});

cnos.read("value.inventory.db.host");
cnos.read("secret.inventory.db.password");
cnos.require("value.server.port");
cnos.readOr("value.server.host", "127.0.0.1");
cnos.inspect("value.inventory.db.host");
```

Optional convenience helpers:

```ts
cnos.value("inventory.db.host");
cnos.secret("inventory.db.password");
cnos.public("api.baseUrl");
```

Projection helpers:

```ts
cnos.toObject();
cnos.toNamespace("value");
cnos.toEnv();
cnos.toPublicEnv();
```

---

## 16. CLI Product Direction

The CLI should be a first-class developer workflow surface.

### 16.1 Read values
```bash
cnos value "db.host.ip"
cnos read value.inventory.db.host
```

### 16.2 Define values
```bash
cnos define value "db.host.ip" "127.0.0.1"
cnos define secret "inventory.db.password" "..."
```

This supports your requirement that people should not have to manually hunt for the right file and edit it themselves.

CNOS should determine the right target file or target profile/layer based on workflow config, current profile, and flags.

### 16.3 Inspect values
```bash
cnos inspect value.inventory.db.host
```

Shows:
- resolved value
- winning source
- override chain

### 16.4 Validate
```bash
cnos validate
```

### 16.5 Export
```bash
cnos export env --profile stage
cnos export env --public
```

### 16.6 Init
```bash
cnos init
```

Creates the starter structure and a default workflow manifest.

### 16.7 Diff
```bash
cnos diff --from local --to stage
```

### 16.8 Doctor
```bash
cnos doctor
```

Potential checks:
- missing profile links
- cycles in inheritance
- unresolved required keys
- public/secret leakage
- invalid source config

---

## 17. Build-Time and Runtime Reading

Readers should work according to surface and lifecycle.

### 17.1 Server runtime
Server apps can read:
- `value.*`
- `secret.*`
- `public.*`

### 17.2 Build-time readers
At build time, CNOS can:
- resolve config
- export env files
- generate public config modules
- prepare framework-compatible public env

### 17.3 Client/browser/UI consumption
UI/browser surfaces should read only:
- `public.*`

### 17.4 Reader timing
CNOS should support:
- build-time reading
- runtime reading
- per-surface projected reading

This matches your requirement that readers on server, UI, and other surfaces may operate at build time or runtime depending on the environment.

---

## 18. Env Interoperability

CNOS should support two-way env interoperability.

### 18.1 Env -> config
Map env variables into logical keys.

Example:

```yaml
envMapping:
  DATABASE_HOST: value.inventory.db.host
  DATABASE_PASSWORD: secret.inventory.db.password
  NEXT_PUBLIC_API_BASE_URL: public.api.baseUrl
```

### 18.2 Config -> env
Export resolved config into flattened env variables for downstream tools and frameworks.

### 18.3 Public export
Export only `public.*` into frontend-safe env or generated modules.

This is important for adoption because it lets teams migrate from dotenv-based systems without rewriting everything at once.

---

## 19. Validation and Schema

Validation should be optional but strongly encouraged.

Possible early schema capabilities:
- required
- type
- enum
- pattern
- default
- public/secret classification checks

Example conceptual schema:

```ts
{
  "value.server.port": { type: "number", required: true },
  "value.server.host": { type: "string", required: true },
  "public.api.baseUrl": { type: "string", required: true },
  "secret.inventory.db.password": { type: "string", required: true }
}
```

A validator plugin can enforce this.

---

## 20. Monorepo Fit

CNOS is especially valuable in monorepo environments.

Potential capabilities:
- root-level shared config
- package/app overlays
- inherited workspace config
- app-specific public exports
- common profile workflows across packages

This should be considered in architecture, even if full workspace support is not fully delivered in v1.

---

## 21. v1 Scope Recommendation

CNOS v1 should be a practical and adoptable OSS wedge.

### 21.1 Must-have v1 scope
- core orchestrator in `@kitsy/cnos-core`
- default plugin system
- filesystem values reader plugin
- filesystem secrets reader plugin
- dotenv reader plugin
- process env reader plugin
- CLI args reader plugin
- simple resolver plugin
- inherited/profile resolver plugin
- root workflow manifest
- profile inheritance
- deterministic precedence
- `read`, `require`, `readOr`, `inspect`
- public config export
- CLI `init`, `read/value`, `define`, `inspect`, `validate`, `export`
- provenance for resolved keys

### 21.2 Defer beyond v1
- encrypted local secret files
- remote secret manager integrations
- kube plugin
- distributed config sync
- live reload
- config UI dashboard
- language ports beyond TypeScript
- advanced policy engine

---

## 22. What Makes CNOS Strong as a Product

CNOS becomes more than another env library if it does these well:

1. **Stable logical key API**
2. **Plugin-based workflow orchestration**
3. **Config-spectrum support from simple to advanced**
4. **Convention-as-config**
5. **Strong provenance/debugging**
6. **Public vs secret enforcement**
7. **CLI editing and inspection**
8. **Monorepo friendliness**
9. **Cross-language portability of the model**

---

## 23. Risks and Guardrails

### 23.1 Over-abstraction
If simple apps need too much setup, adoption suffers.

**Guardrail:** keep simple mode easy and batteries-included.

### 23.2 Secret confusion
If `secrets/` files exist, users may assume CNOS is secure secret storage.

**Guardrail:** document clearly that CNOS is a config orchestrator, not itself a secure vault.

### 23.3 Too much in v1
Trying to solve the full spectrum in the first release will dilute execution.

**Guardrail:** ship a clean Node/TypeScript v1 wedge.

### 23.4 Ambiguous writes
CLI `define` must have deterministic write targeting.

**Guardrail:** make write targets explicit by profile/layer or derive them via declared policies.

### 23.5 Public leakage
Public export must never include secret keys.

**Guardrail:** hard enforcement in export pipeline and validation.

---

## 24. Naming

A useful expansion is:

**CNOS = Config Namespace Operating System**

Even if it is not literally an operating system, the name communicates the ambition:
- logical namespaces
- pluggable orchestration
- config workflow coordination

---

## 25. Recommended Initial OSS Positioning

Initial wedge:

> **A better dotenv-to-structured-config upgrade path for applications and monorepos.**

The first win should be:
- easy for simple apps
- structured for growing systems
- inspectable and debuggable
- ready for future plugin growth

---

## 26. Sample End-to-End Story

A team starts with:
- `.env`
- `.env.local`
- shell env
- one service

Later they need:
- stage/prod layering
- shared base values
- separate secrets
- frontend-safe public config
- monorepo consistency

With CNOS, application code remains:

```ts
cnos.require("value.inventory.db.host");
cnos.require("secret.inventory.db.password");
cnos.require("public.api.baseUrl");
```

Only CNOS workflow config and plugins evolve.

That is the product value.

---

## 27. Recommended Next Artifacts

After this document, the next implementation-ready artifacts should be:

1. **CNOS v1 implementation spec**
   - exact manifest schema
   - plugin contracts
   - resolver semantics
   - write-target rules for `define`

2. **TypeScript package blueprint**
   - package boundaries
   - interfaces
   - internal module layout

3. **CLI command spec**
   - command grammar
   - output format
   - write/patch semantics

4. **Codex implementation prompt**
   - for bootstrapping `@kitsy/cnos-core`, `@kitsy/cnos`, and `@kitsy/cnos-cli`

---

## 28. Final Recommendation

Proceed with CNOS as:

- **core orchestrator first**
- **plugin contracts early**
- **simple batteries-included v1 plugins**
- **Node/TypeScript first**
- **logical key API as the invariant**
- **full-spectrum support as architectural direction, not v1 feature scope**

This keeps the product ambitious but executable.

The guiding statement should be:

> **CNOS is a config workflow orchestrator. Application code reads logical keys. Plugins decide how config is read, resolved, validated, and exported.**
