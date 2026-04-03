# CNOS Repo Setup Instruction Spec (pnpm Monorepo + npm Publishing)

**Project:** `cnos`  
**Primary packages:** `@kitsy/cnos-core`, `@kitsy/cnos`, `@kitsy/cnos-cli`  
**Type:** Codex-facing repo setup and scaffolding instruction spec  
**Goal:** Create a clean pnpm monorepo workspace for implementing, testing, documenting, and publishing CNOS packages

---

## 1. Objective

Set up CNOS as a **pnpm monorepo workspace** with a package structure that matches the intended architecture:

- `@kitsy/cnos-core` is the workflow orchestrator
- `@kitsy/cnos` is the batteries-included runtime package
- `@kitsy/cnos-cli` is the developer CLI
- official plugins are separate packages from day one
- the workspace supports local development, testing, examples, docs, and npm publishing

This setup must preserve the long-term design goal:

> Application code reads logical config keys. CNOS plugins decide how config is read, resolved, validated, inspected, and exported.

---

## 2. High-Level Repository Shape

Create a single pnpm workspace repo with this structure:

```text
cnos/
  .changeset/
  .github/
    workflows/
      ci.yml
      release.yml

  docs/
    cnos-v1-product-architecture-spec.md
    cnos-v1-implementation-spec.md
    cnos-v1-codex-bootstrap-prompt.md
    cnos-repo-setup-instruction-spec.md

  examples/
    basic-node/
    layered-config/
    monorepo-app/

  packages/
    cnos-core/
    cnos/
    cnos-cli/
    cnos-plugin-filesystem/
    cnos-plugin-dotenv/
    cnos-plugin-process-env/
    cnos-plugin-cli-args/
    cnos-plugin-basic-schema/
    cnos-plugin-env-export/

  .editorconfig
  .gitignore
  .npmrc
  .prettierignore
  .prettierrc
  LICENSE
  README.md
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
```

---

## 3. Package Strategy

## 3.1 Required publishable packages

Create and configure these packages:

- `@kitsy/cnos-core`
- `@kitsy/cnos`
- `@kitsy/cnos-cli`
- `@kitsy/cnos-plugin-filesystem`
- `@kitsy/cnos-plugin-dotenv`
- `@kitsy/cnos-plugin-process-env`
- `@kitsy/cnos-plugin-cli-args`
- `@kitsy/cnos-plugin-basic-schema`
- `@kitsy/cnos-plugin-env-export`

## 3.2 Package responsibilities

### `@kitsy/cnos-core`
Owns:
- workflow orchestrator
- plugin contracts
- manifest model
- profile resolution model
- normalized internal config entry model
- resolved graph model
- runtime API contracts
- shared low-level utilities that are core-only

### `@kitsy/cnos`
Owns:
- default batteries-included developer entry point
- prewiring of official v1 plugins
- `createCnos(...)` convenience runtime
- friendly re-exports of common runtime APIs/types

### `@kitsy/cnos-cli`
Owns:
- `cnos` executable
- CLI command parsing and routing
- `init`, `read`, `value`, `define`, `inspect`, `validate`, `export`, `doctor`
- user-facing formatting for outputs

### Plugin packages
Each plugin package owns one coherent extension area and depends on `@kitsy/cnos-core`.

---

## 4. Why Plugins Must Be Separate Packages

Do not put all plugins directly inside `cnos-core`.

The architecture is explicitly plugin-based, and the repo should reflect that from the beginning. Keeping plugins as standalone packages provides:

- cleaner boundaries
- lower refactor risk later
- easier testing
- easier future replacement/extension
- clearer external adoption model
- better long-term alignment with kube-like or platform-specific plugins later

This means the plugin architecture is real, not just conceptual.

---

## 5. Workspace Setup

## 5.1 `pnpm-workspace.yaml`

Create:

```yaml
packages:
  - "packages/*"
  - "examples/*"
```

## 5.2 Root `package.json`

Use a private root package:

```json
{
  "name": "cnos",
  "private": true,
  "packageManager": "pnpm@10",
  "scripts": {
    "build": "pnpm -r build",
    "clean": "pnpm -r clean && rimraf node_modules .artifacts",
    "dev": "pnpm -r --parallel dev",
    "lint": "pnpm -r lint",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "check": "pnpm lint && pnpm typecheck && pnpm test",
    "publish:check": "pnpm -r pack --pack-destination .artifacts",
    "changeset": "changeset",
    "version-packages": "changeset version",
    "release": "changeset publish"
  }
}
```

Notes:
- repo root stays private
- publishable units are package-level
- keep scripts simple and recursive

---

## 6. TypeScript and Build Setup

## 6.1 Root `tsconfig.base.json`

Create a shared base config:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": false,
    "sourceMap": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

## 6.2 Build tool

Use **tsup** as the v1 package build tool for all libraries and CLI packages.

Reasons:
- simple library packaging
- easy ESM/CJS output
- easy type declaration generation
- fast dev watch mode
- suitable for CLI bundles

---

## 7. Shared Dev Tooling

Use this tooling set in the monorepo:

- TypeScript
- pnpm
- tsup
- vitest
- eslint
- prettier
- rimraf
- changesets

This is sufficient for v1 and keeps the stack lean.

---

## 8. Root Config Files

Create these root files:

### `.gitignore`
Ignore:
- `node_modules`
- `dist`
- `.turbo` if introduced later
- `.artifacts`
- coverage
- local environment files
- OS/editor junk

### `.npmrc`
Keep npm config minimal and safe. Do not commit tokens.

### `.editorconfig`
Normalize line endings, tabs/spaces, trailing newlines.

### `.prettierrc`
Define formatting once for all packages.

### `README.md`
Explain:
- what CNOS is
- package overview
- workspace commands
- local development
- release flow

### `LICENSE`
Choose OSS license explicitly.

---

## 9. Per-Package Template

Each library package should include:

```text
package/
  package.json
  tsconfig.json
  README.md
  src/
    index.ts
  test/
```

## 9.1 Example library package `package.json`

Use a shape like:

```json
{
  "name": "@kitsy/cnos-core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": [
    "dist"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts",
    "clean": "rimraf dist",
    "dev": "tsup src/index.ts --watch --format esm,cjs --dts",
    "lint": "eslint src test",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

## 9.2 Example CLI package `package.json`

For `@kitsy/cnos-cli`, include a `bin` field:

```json
{
  "name": "@kitsy/cnos-cli",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "cnos": "./dist/index.js"
  },
  "files": [
    "dist"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --banner.js '#!/usr/bin/env node'",
    "clean": "rimraf dist",
    "dev": "tsup src/index.ts --watch --format esm --dts --banner.js '#!/usr/bin/env node'",
    "lint": "eslint src test",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

---

## 10. Package Dependency Direction

Keep dependency flow strict.

### Allowed dependency direction

- plugin packages -> `@kitsy/cnos-core`
- `@kitsy/cnos` -> `@kitsy/cnos-core` + official plugin packages
- `@kitsy/cnos-cli` -> `@kitsy/cnos` and possibly `@kitsy/cnos-core` types

### Disallowed direction

- `cnos-core` must not depend on `cnos`
- `cnos-core` must not depend on CLI code
- plugins must not depend on `cnos`
- plugin packages should not depend on each other unless absolutely necessary
- CLI-specific formatting should not leak into runtime packages

This is a critical architectural constraint.

---

## 11. Internal Source Layout Recommendation

## 11.1 `packages/cnos-core/src`

Recommended structure:

```text
src/
  index.ts
  types/
    core.ts
    manifest.ts
    plugin.ts
    profile.ts
  manifest/
    loadManifest.ts
    normalizeManifest.ts
  profiles/
    resolveActiveProfile.ts
    expandProfileGraph.ts
  orchestrator/
    createCnos.ts
    runtime.ts
    pipeline.ts
  runtime/
    read.ts
    require.ts
    inspect.ts
  utils/
    flatten.ts
    deepMerge.ts
    path.ts
    yaml.ts
```

## 11.2 Plugin package structure

Example for `cnos-plugin-filesystem`:

```text
src/
  index.ts
  filesystemValuesReader.ts
  filesystemSecretsReader.ts
  helpers.ts
```

Example for `cnos-plugin-env-export`:

```text
src/
  index.ts
  toEnv.ts
  toPublicEnv.ts
```

## 11.3 `packages/cnos/src`

Keep this package mostly as assembly:

```text
src/
  index.ts
  createCnos.ts
  defaultPlugins.ts
```

## 11.4 `packages/cnos-cli/src`

Recommended structure:

```text
src/
  index.ts
  commands/
    init.ts
    read.ts
    value.ts
    define.ts
    inspect.ts
    validate.ts
    export.ts
    doctor.ts
  services/
    runtime.ts
    writes.ts
  format/
    printJson.ts
    printTable.ts
    printInspect.ts
```

---

## 12. Examples Directory

Create these examples from the start.

## 12.1 `examples/basic-node`
Purpose:
- demonstrate minimal adoption
- `.env` plus one config file
- read/require example

## 12.2 `examples/layered-config`
Purpose:
- demonstrate local/stage/prod layering
- values + secrets + env
- `inspect()` example
- public export example

## 12.3 `examples/monorepo-app`
Purpose:
- demonstrate root config plus app-specific overlays
- workspace usage pattern
- future-proof monorepo story

The examples are both documentation and integration tests.

---

## 13. Docs Strategy

Store major specs in `docs/`.

At minimum include:
- product architecture spec
- implementation spec
- Codex bootstrap prompt
- repo setup instruction spec

Each package should also have its own local `README.md`.

The root `README.md` should explain:
- project purpose
- package map
- quick start
- workspace commands
- publishing flow

---

## 14. Testing Strategy

Use **Vitest** in each package.

### Required test layers

#### Unit tests
Per package:
- plugin behavior
- manifest parsing
- profile resolution
- flattening/merge logic
- export safety

#### Integration tests
At workspace level or package level:
- full config flow with example files
- CLI command behavior
- define/write flow
- export flow
- public/secret boundary enforcement

#### Golden tests
Recommended for:
- CLI output
- exported env snapshots
- inspect/provenance output

---

## 15. Versioning and Release Strategy

Use **Changesets** for monorepo versioning and release management.

### Recommendation
Start with synchronized package versions across the official packages to keep v1 releases simple.

That means:
- `@kitsy/cnos-core`
- `@kitsy/cnos`
- `@kitsy/cnos-cli`
- official plugins

all move together initially.

If needed later, versions can become more independent.

---

## 16. Publishing Strategy

## 16.1 Root repo
The repo root stays private and is not published.

## 16.2 Publishable packages
Each publishable package must define:
- `name`
- `version`
- `files`
- `exports`
- `license`
- `repository`
- `homepage`
- `bugs`
- `keywords`
- `publishConfig.access = "public"` for public scoped npm publishing

## 16.3 Access and safety
- publish only from built `dist/`
- verify packed output before publishing
- never commit auth tokens
- do not publish example apps unless intentionally needed

---

## 17. CI Setup

Create `.github/workflows/ci.yml`.

CI should run on pushes and pull requests and perform:

1. install dependencies
2. lint
3. typecheck
4. test
5. build

Keep CI simple and reliable.

---

## 18. Release Workflow

Create `.github/workflows/release.yml`.

Use Changesets-based release automation.

The release workflow should:
- install dependencies
- build
- optionally run tests
- run changesets publish flow
- publish packages to npm when a release is intended

Do not embed registry tokens in code or checked-in files.

---

## 19. Initial Implementation Order

Scaffold packages in this order:

1. `@kitsy/cnos-core`
2. `@kitsy/cnos-plugin-filesystem`
3. `@kitsy/cnos-plugin-dotenv`
4. `@kitsy/cnos-plugin-process-env`
5. `@kitsy/cnos-plugin-cli-args`
6. `@kitsy/cnos-plugin-basic-schema`
7. `@kitsy/cnos-plugin-env-export`
8. `@kitsy/cnos`
9. `@kitsy/cnos-cli`

This order mirrors architectural dependencies and reduces churn.

---

## 20. Codex Execution Requirements

When implementing this repo setup, Codex must:

- scaffold the workspace root and package directories
- create all root config files
- wire pnpm workspace configuration correctly
- create package manifests and tsconfig files
- set up shared scripts for build/test/lint/typecheck
- keep plugin packages separate from `cnos-core`
- create example directories
- add Changesets setup
- add GitHub workflow files for CI and release
- avoid committing secrets or registry tokens
- keep publish setup npm-compatible
- preserve the package boundaries exactly as described

---

## 21. Important Constraints

### Do not
- collapse plugins into `cnos-core`
- mix CLI code into runtime packages
- overcomplicate build tooling
- add framework-specific code to core repo setup
- create hidden dependency cycles
- make the root package publishable
- introduce Docker or Turborepo unless explicitly needed later

### Do
- keep the workspace minimal, explicit, and publish-ready
- optimize for library development and release discipline
- preserve architectural clarity from day one

---

## 22. Root Scripts to Include

Use these scripts at the repo root:

```json
{
  "scripts": {
    "build": "pnpm -r build",
    "clean": "pnpm -r clean && rimraf node_modules .artifacts",
    "dev": "pnpm -r --parallel dev",
    "lint": "pnpm -r lint",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "check": "pnpm lint && pnpm typecheck && pnpm test",
    "publish:check": "pnpm -r pack --pack-destination .artifacts",
    "changeset": "changeset",
    "version-packages": "changeset version",
    "release": "changeset publish"
  }
}
```

---

## 23. Recommended Deliverables from Codex

Codex should return a repo scaffold that includes:

1. root workspace files
2. all package directories
3. package manifests
4. tsconfig files
5. initial `src/index.ts` stubs
6. test folders
7. example app folders
8. CI workflow
9. release workflow
10. Changesets initialization
11. root and package README files

This first pass is about **repo structure and publishing foundation**, not full CNOS logic.

---

## 24. Final Direction

Treat this repo setup as the structural foundation for CNOS v1.

The repo must visibly encode the intended product architecture:
- orchestrator core
- plugin-based extensions
- batteries-included runtime package
- dedicated CLI
- publishable OSS packages
- examples and docs for adoption

That structure should be correct before deep implementation begins.
