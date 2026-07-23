# CNOS - Architecture

## Package Boundaries

The repo is split by responsibility. This matters when you decide where code belongs.

### `packages/core`

The core engine and contracts live here. `@kitsy/cnos-core` is a private workspace
package and is never published directly; public Node packages bundle the core code and
declarations they expose.

- manifest loading and normalization
- workspace and profile resolution
- derived value parsing and evaluation
- graph resolution and validation
- secret providers and hydration
- runtime conversion helpers such as `toEnv()`, `toPublicEnv()`, and `toServerProjection()`
- shared public types in `packages/core/src/types/`

### `packages/cnos`

This is the batteries-included runtime package:

- wraps `@kitsy/cnos-core`
- provides `createCnos()` and the default singleton runtime
- bootstraps from `__CNOS_GRAPH__`, `__CNOS_PROJECTION__`, or `.cnos-server.json`
- exposes browser/build entrypoints
- re-exports official plugin packages from `packages/cnos/src/plugin/`

### `plugins/*`

Official built-in plugins live in dedicated packages:

- `plugins/filesystem`
- `plugins/dotenv`
- `plugins/process-env`
- `plugins/cli-args`
- `plugins/basic-schema`
- `plugins/env-export`

If you add or change an official built-in plugin, this is usually the write surface. `packages/cnos/src/defaultPlugins.ts` wires those packages into the default runtime.

### `packages/cli`

The CLI package owns:

- command handlers in `src/commands/`
- canonical help definitions in `src/cli/helpRegistry.ts`
- argument parsing, output formatting, and repo workflow helpers in `src/services/`

### `packages/docs`

This package publishes the docs content consumed by the web docs site and other docs consumers:

- docs pages in `packages/docs/docs/`
- navigation in `packages/docs/manifest.yml`
- validation in `packages/docs/scripts/validate-docs.mjs`

### `packages/var-server`

Embeddable `var.*` control-plane library (`@kitsy/cnos-var-server`): the mutation engine
(create/validate/activate/deactivate/rollback, optimistic concurrency, idempotency), pluggable
storage (`memoryStore()`, `fileStore()` append-only log), the embeddable HTTP handler
(`varServer(store, opts)`), and the standalone wrapper (`serveVarServer`, backs `cnos var
serve`). Library-first — CNOS never runs its own sidecar process; a host embeds this on its
existing server or runs the thin standalone wrapper. See `.agents/context/runtime-vars.md`.

### `packages/var-http`

The `http` transport `VarSourceProvider` module (`@kitsy/cnos-var-http`) — pull with
ETag/`If-None-Match`, mapping `404 {code:"no-head"}` and `304` to the corresponding core
errors. Registered by default in the batteries-included `@kitsy/cnos` package.

`packages/var-rpc` (gRPC transport, `cnos.var.v1`) is in progress and not covered here yet —
treat it as its own docs/architecture follow-up once it lands.

### `packages/var-testkit`

Test doubles for `var.*` (`@kitsy/cnos-var-testkit`), mirroring `packages/vault-testkit`: an
ephemeral `startTestVarServer()` and a transport-free `createInMemoryVarSource()` double for
exercising consumer SDK pull/subscribe/close without a network hop.

## Resolution Pipeline

CNOS resolves config in this order:

```text
1. Discovery       -> find .cnosrc.yml and resolve the root
2. Manifest load   -> parse and normalize .cnos/cnos.yml
3. Workspace       -> resolve active workspace and inheritance chain
4. Profile         -> resolve active profile and inheritance chain
5. Loading         -> run loader plugins for the effective roots/layers
6. Resolution      -> merge entries by precedence
7. Promotion       -> mirror promoted values into public.*
8. Derivation      -> parse/evaluate config-only derivations, track runtime-dependent ones
9. Validation      -> schema, namespace, promotion, and workspace safety checks
10. Projection     -> build runtime/env/public/server outputs as needed
11. Secret hydrate -> resolve secret refs according to the active policy
12. Ready          -> runtime is available for reads
```

## Core Types

These are the important stable contracts. The canonical definitions live in `packages/core/src/types/`.

```ts
type LogicalKey = string;
type NamespaceName = string;

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
  profileSource: ProfileSource;
  workspace: WorkspaceContext;
}

interface CnosRuntime {
  manifest: NormalizedManifest;
  plugins: CnosPlugin[];
  readonly graph: ResolvedGraph;
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
  toServerProjection(): ServerProjection;
  registerRuntimeProvider(namespace: string, provider: RuntimeProvider): void;
  refreshSecrets(): Promise<void>;
  refreshSecret(key: LogicalKey): Promise<void>;
}

interface ServerProjection {
  version: 1;
  workspace: string;
  profile: string;
  resolvedAt: string;
  configHash: string;
  values: Record<string, unknown>;
  derived: Record<string, DerivedFormula>;
  secretRefs: Record<string, SecretReference & { envVar?: string }>;
  // var.* authoring blocks — present only when the manifest declares varSources/vars.
  varSources?: Record<string, ProjectedVarSourceDefinition>; // refs only, never resolved auth material
  vars?: Record<string, VarGroupDefinition>;
  documents?: Record<string, DocumentSchemaDefinition>;
  schema?: Record<string, ProjectedVarKeyRule>; // keyed by full var.* key; `default` present only when declared
  publicKeys: string[];
  runtimeNamespaces: string[];
  meta: {
    workspace: string;
    profile: string;
    cnos_version: string;
    namespaces?: string[];
  };
}
```

The `var.*` blocks are populated by `packages/core/src/runtime/toServerProjection.ts`. `var.*`
never appears in `values`/`publicKeys` — it is its own set of blocks with its own overlay
precedence, resolved at read time by the runtime SDK, not baked into `values` at projection
time. See `.agents/context/runtime-vars.md` for the full module map and wire conventions.

## Runtime Surfaces

There are two runtime layers that agents often confuse.

### Core runtime

`createCnos()` returns a `CnosRuntime` from `@kitsy/cnos-core`. This is the stable engine-level contract.

### Singleton wrapper

The default export from `@kitsy/cnos` adds singleton ergonomics on top of the core runtime:

- `cnos(key)` shorthand
- `ready()`
- `format(message)`
- `log(message)`
- `loadProjection(path)`

Those helpers live in `packages/cnos/src/runtime/index.ts`. Do not document them as part of the core runtime contract.

## Module Layout

Use these directories as the stable map of the codebase.

### `packages/core/src/`

```text
derive/         parser, template parser, evaluator, dep graph, runtime support
discovery/      .cnosrc search, git URI parsing, root resolution, cache manager
inspectors/     provenance / inspect support
manifest/       manifest and workspace-file loading / normalization
orchestrator/   createCnos pipeline and runtime assembly
profiles/       profile activation and inheritance
promotions/     public promotion and promotion validation
resolvers/      graph merge / precedence resolver
runtime/        read helpers, env/public/server projection, dump helpers
secrets/        auth resolution, providers, cache, audit log, batch resolve
types/          core public contracts
utils/          shared helpers
validation/     schema, env mapping, public safety, workspace safety
workspaces/     workspace selection and inheritance
```

### `packages/cnos/src/`

```text
browser/        browser runtime entrypoint
build/          framework/build helpers
configure/      explicit runtime creation entrypoint
plugin/         plugin package re-exports
runtime/        singleton runtime bootstrap and helpers
createCnos.ts   batteries-included runtime creation
defaultPlugins.ts
index.ts
internal.ts
```

### `plugins/<name>/src/`

Each official plugin package owns its own implementation. Add new built-in plugin behavior there, not in `packages/cnos/src/`.

### `packages/cli/src/`

```text
cli/            args parsing and help registry
commands/       user-facing commands
format/         output shaping
services/       shared command logic
```

### `packages/var-server/src/`

```text
types.ts        VarStore / VarEvent / ScopeHead / ScopeStatus contracts
engine.ts       VarEngine — create/validate/activate/deactivate/rollback, locking, idempotency
memoryStore.ts  ephemeral store
fileStore.ts    append-only JSONL store (audit, replay, restart resume)
baseStore.ts    shared fold/replay logic behind both stores
authorize.ts    pluggable authorize hook + static bearer helper
httpServer.ts   embeddable Node HTTP handler (read plane + admin mutation routes)
serve.ts        standalone http.createServer wrapper (backs `cnos var serve`)
hash.ts         canonical JSON + content-addressed revision hashing
errors.ts       CnosVarConflictError / CnosVarValidationError / CnosVarNotFoundError / CnosVarStoreError
```

### `packages/var-http/src/`, `packages/var-testkit/src/`

Each is a single `index.ts`: the http `VarSourceProvider` module, and the test-double
factories (`startTestVarServer`, `createInMemoryVarSource`), respectively.

## CLI Surface

Do not treat this file as the canonical CLI registry. The authoritative sources are:

- `packages/cli/src/cli/helpRegistry.ts`
- `cnos help-ai --format json`

At a high level, the top-level CLI surface currently includes:

- setup and context: `init`, `onboard`, `use`, `profile`
- data operations: `read`, `value`, `secret`, `define`, `list`, `promote`, `inspect`, `validate`
- workflows: `export`, `build`, `dev`, `run`, `dump`, `diff`, `doctor`, `drift`, `watch`, `migrate`
- workspace and secrets: `workspace`, `vault`, `cache`
- var control plane: `var` (`create`, `validate`, `activate`, `deactivate`, `rollback`, `status`, `history`, `replay`, `serve`)
- meta/help: `help`, `help-ai`, `version`

When CLI behavior changes, update `helpRegistry.ts` first, then the published docs under `packages/docs/docs/cli/`.

## Docs Surface

Published docs live in `packages/docs`. The package name is still `@kitsy/cnos-docs`.

The docs validation script should catch:

- missing frontmatter
- manifest entries that point to missing pages
- orphan docs pages
- broken internal links
- missing top-level CLI reference pages for commands exposed through `helpRegistry.ts`

## Common Write Surfaces

Use this map before editing:

- manifest or profile/workspace behavior: `packages/core/src/manifest`, `packages/core/src/profiles`, `packages/core/src/workspaces`
- derived values: `packages/core/src/derive`
- resolution or validation: `packages/core/src/resolvers`, `packages/core/src/validation`, `packages/core/src/promotions`
- secret behavior: `packages/core/src/secrets`
- runtime variables (`var.*`) consumer-side model: `packages/core/src/runtime/{readVar,varStore,varManager}.ts`, `packages/core/src/validation/validateVars.ts`, `packages/core/src/manifest/normalizeVars.ts`
- runtime variables control plane (authority): `packages/var-server/src`
- runtime variables transports: `packages/var-http/src` (http); `packages/var-rpc` (gRPC) is in progress elsewhere, not yet in this tree
- singleton/runtime bootstrap: `packages/cnos/src/runtime`, `packages/cnos/src/varReceiver.ts`
- official plugin logic: `plugins/*/src`
- CLI commands/help: `packages/cli/src/commands`, `packages/cli/src/cli/helpRegistry.ts`; var control-plane CLI: `packages/cli/src/commands/var.ts`, `packages/cli/src/services/varControl.ts`
- published docs: `packages/docs/docs`, `packages/docs/manifest.yml`

## Error Types

Look for typed CNOS errors before inventing a new generic one. The common families include:

- discovery errors
- validation errors
- security errors
- authentication errors
- derived-value cycle / resolution errors
- var runtime errors (`CnosVarRequiredError`, `CnosVarNoHeadError`, `CnosVarNotModifiedError` in `packages/core/src/errors.ts`) and var control-plane errors (`CnosVarConflictError`, `CnosVarValidationError`, `CnosVarNotFoundError`, `CnosVarStoreError` in `packages/var-server/src/errors.ts` — a separate hierarchy from the core `CnosError` family)

If you add a new user-facing failure mode, make the message actionable: say what failed, which key/file/root was involved, and what the user should do next.
