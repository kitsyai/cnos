# CNOS — Architecture

## Pipeline

CNOS resolves config in this order. Each stage completes before the next begins.

```
1. Discovery      → find .cnosrc.yml, resolve root path (local or remote)
2. Manifest load  → parse .cnos/cnos.yml, normalize, apply defaults
3. Workspace      → select workspace, expand inheritance chain, compute effective roots
4. Profile        → select profile, expand inheritance chain
5. Loading        → run loader plugins against effective roots for activated profile layers
6. Resolution     → merge entries with precedence, deep merge objects, last-writer-wins scalars
7. Promotion      → mirror promoted value.* keys into public.* namespace
8. Derivation     → parse $derive expressions, topological sort, pre-evaluate config-only derivations
9. Validation     → schema checks, public safety, namespace safety, cycle detection
10. Projection    → generate server/browser/env projections as needed
11. Secret hydration → batch-resolve secret refs from vault providers (eager/lazy/refreshing)
12. Ready         → runtime available for reads
```

## Core Types

```ts
type LogicalKey = string;      // "value.server.port", "secret.db.password"
type NamespaceName = string;   // validated against builtins + custom

interface ConfigEntry {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  sourceId: string;            // "filesystem-values", "dotenv", "cli-args"
  pluginId: string;
  streamId: string;            // which stream produced this
  workspaceId: string;
  profile?: string;
  origin?: {
    file?: string;
    line?: number;
    envVar?: string;
    cliArg?: string;
  };
}

interface ResolvedEntry {
  key: LogicalKey;
  value: unknown;              // concrete value, DerivedValue, or SecretRef
  namespace: NamespaceName;
  winner: ConfigEntry;
  overridden: ConfigEntry[];
}

interface ResolvedGraph {
  entries: Map<LogicalKey, ResolvedEntry>;
  workspace: WorkspaceContext;
  profile: string;
  resolvedAt: string;
  profileSource: string;
  activeStreams: string[];
}

interface WorkspaceContext {
  workspaceId: string;
  workspaceSource: "cli" | "workspace-file" | "manifest-default" | "implicit";
  globalRoot?: string;
  globalEnabled: boolean;
  workspaceChain: string[];
  workspaceRoots: Array<{ scope: "global" | "local"; workspaceId: string; path: string }>;
}

interface ServerProjection {
  version: 1;
  workspace: string;
  profile: string;
  resolvedAt: string;
  configHash: string;
  values: Record<string, unknown>;
  derived: Record<string, DerivedFormula>;
  secretRefs: Record<string, SecretRef>;
  publicKeys: string[];
  runtimeNamespaces: string[];
  meta: { workspace: string; profile: string; cnos_version: string };
}

interface SecretRef {
  provider: string;
  vault: string;
  ref: string;
}

interface DerivedValue {
  $derive: string | { expr: string };
}

interface DerivedFormula {
  expr: string;
  deps: string[];
  runtimeRefs: string[];
}
```

## Plugin Contracts

```ts
interface LoaderPlugin {
  id: string;
  kind: "loader";
  load(context: LoaderContext): Promise<ConfigEntry[]>;
}

interface ResolverPlugin {
  id: string;
  kind: "resolver";
  resolve(entries: ConfigEntry[], context: ResolverContext): Promise<ResolvedGraph>;
}

interface ValidatorPlugin {
  id: string;
  kind: "validator";
  validate(graph: ResolvedGraph, context: ValidationContext): Promise<ValidationResult>;
}

interface SecretVaultProvider {
  readonly id: string;
  readonly providerType: string;
  authenticate(authConfig: VaultAuthConfig): Promise<void>;
  isAuthenticated(): boolean;
  batchGet(refs: string[]): Promise<Map<string, string>>;
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
  list(): Promise<string[]>;
  clearCache(): void;
}
```

## Runtime API

```ts
interface CnosRuntime {
  read<T = unknown>(key: LogicalKey): T | undefined;
  require<T = unknown>(key: LogicalKey): T;       // throws CnosKeyNotFoundError
  readOr<T>(key: LogicalKey, fallback: T): T;
  value<T = unknown>(path: string): T | undefined; // shorthand: value("server.port") → read("value.server.port")
  secret<T = unknown>(path: string): T | undefined;
  meta<T = unknown>(path: string): T | undefined;

  inspect(key: LogicalKey): InspectResult;
  surface(name: string): SurfaceView;

  toObject(): Record<string, unknown>;
  toNamespace(namespace: NamespaceName): Record<string, unknown>;
  toEnv(options?: ToEnvOptions): Record<string, string>;
  toPublicEnv(options?: ToPublicEnvOptions): Record<string, string>;
  toServerProjection(): ServerProjection;

  refreshSecrets(): Promise<void>;
  refreshSecret(key: string): Promise<void>;
  clearSecretCache(): void;
  registerRuntimeProvider(namespace: string, provider: RuntimeProvider): void;

  readonly graph: ResolvedGraph;
  readonly workspace: WorkspaceContext;
  ready(): Promise<void>;
}
```

## Module Layout

```
packages/cnos/src/
  index.ts                         # createCnos, singleton, re-exports
  browser/
    index.ts                       # @kitsy/cnos/browser entry
    embed.ts                       # reads build-time injected data
  build/
    index.ts                       # resolveBrowserData, toFrameworkEnv
  discovery/
    findCnosrc.ts                  # bounded .cnosrc.yml search (max 3 levels)
    parseCnosrc.ts                 # parse and validate
    resolveRoot.ts                 # protocol detection: local, git, cnos://
    resolvers/
      local.ts                     # local filesystem path resolution
      git.ts                       # git clone/fetch/cache
    cache/
      cacheManager.ts              # freshness, TTL, immutability
  derive/
    types.ts                       # DerivedValue, ParsedDerivation, ExprNode
    parser.ts                      # expression → AST
    templateParser.ts              # template ${...} → AST
    evaluator.ts                   # AST + graph + runtime providers → value
    depGraph.ts                    # dependency extraction, topo sort, cycle detection
    builtins.ts                    # concat, coalesce, when, exists, eq, ne
    validate.ts                    # namespace checks, syntax validation
  manifest/
    loadManifest.ts                # read and parse .cnos/cnos.yml
    normalizeManifest.ts           # validate, apply defaults
    loadWorkspaceFile.ts           # .cnos-workspace.yml
  workspaces/
    resolveWorkspaceContext.ts     # selection, chain expansion, effective roots
    expandWorkspaceChain.ts        # inheritance, cycle detection
  profiles/
    resolveActiveProfile.ts        # CLI > env > manifest default
    expandProfileChain.ts          # inheritance, cycle detection
  orchestrator/
    createCnos.ts                  # main entry point
    singleton.ts                   # default stream singleton
    runtime.ts                     # CnosRuntime implementation
    pipeline.ts                    # discovery → manifest → workspace → profile → load → resolve → validate → ready
  loaders/
    filesystemValues.ts            # YAML files → value.* entries
    filesystemSecrets.ts           # YAML files → secret.* ref entries
    dotenv.ts                      # .env files → mapped entries
    processEnv.ts                  # process.env → mapped entries
    cliArgs.ts                     # --value.x.y=z → entries
  resolvers/
    profileAwareResolver.ts        # single resolver: workspace roots × profile layers × precedence
  validators/
    basicSchema.ts                 # type, required, enum, pattern, default
    publicSafety.ts                # secret.* never in public.promote
    namespaceSafety.ts             # custom namespace rules
  promotions/
    promoteToPublic.ts             # create public.* mirror entries
    validatePromotion.ts           # transitive security checks
  exporters/
    toEnv.ts                       # flat KEY=VALUE export
    toPublicEnv.ts                 # promoted keys with framework prefix
    dump.ts                        # filesystem materialization
  projection/
    serverProjection.ts            # toServerProjection()
    projectionHash.ts              # SHA-256 config hash
    formats/
      dotenv.ts, json.ts, shell.ts, yaml.ts, dockerEnv.ts, toml.ts
  inspectors/
    provenance.ts                  # winner, overrides, workspace, profile context
  secrets/
    types.ts                       # SecretRef, VaultAuthConfig
    resolveAuth.ts                 # auth chain: env → keychain → prompt
    secretCache.ts                 # per-runtime in-memory cache
    batchResolve.ts                # batch-fetch grouped by vault
    auditLog.ts                    # JSON lines access log
    mask.ts                        # **** masking for CLI/TTY
    providers/
      local.ts                     # AES-256-GCM encrypted vault
      github.ts                    # process.env reader with mapping
      registry.ts                  # provider registry
    crypto/
      encrypt.ts                   # AES-256-GCM
      kdf.ts                       # PBKDF2-SHA512, 600K iterations
      sessionKey.ts                # cnos run --auth one-time key
  runtime/
    runtimeProviders.ts            # provider registry, process.* default
    loadProjection.ts              # parse from env var or .cnos-server.json
    autoDiscover.ts                # __CNOS_PROJECTION__ → file → full resolution
    secretHydration.ts             # eager/lazy/refreshing policies
  codegen/
    generateTypes.ts               # schema → TypeScript interfaces
  migrate/
    scanEnvUsage.ts                # regex scanner for process.env patterns
    proposeMapping.ts              # env var → logical key proposal
  drift/
    compareSchemaToGraph.ts        # schema vs resolved graph diff
  watch/
    watchFiles.ts                  # determine watchable file set
    diffGraphs.ts                  # compare two ResolvedGraphs
  utils/
    path.ts, flatten.ts, deepMerge.ts, yaml.ts, envNaming.ts
```

## Manifest Shape (`.cnos/cnos.yml`)

```yaml
version: 1

project:
  name: my-service

workspaces:
  default: base
  global:
    enabled: false
    root: ~/.cnos
    allowWrite: false
  items:
    base: {}
    api:
      extends: [base]
      globalId: api

profiles:
  default: local
  resolveFrom: [cli.profile, env.CNOS_PROFILE, default]

config:
  precedence: [local, env]       # stream IDs, lowest to highest
  arrayPolicy: replace
  write:
    defaultProfile: local
    targets:
      value: ./values/{profile}/app.yml
      secret: ./secrets/{profile}/app.yml

namespaces:
  custom:
    flag:
      source: firebase
      promotable: true
      sensitive: false
  runtime:
    request:
      server_only: true
    session:
      server_only: true

env:
  convention: SCREAMING_SNAKE
  export:
    DATABASE_HOST: value.db.host
    PORT: value.server.port

public:
  promote:
    - value.api.baseUrl
    - value.app.name
  frameworks:
    next: NEXT_PUBLIC_
    vite: VITE_

vaults:
  local-dev:
    provider: local
    auth:
      passphrase:
        from: [env:CNOS_SECRET_PASSPHRASE_LOCAL_DEV, env:CNOS_SECRET_PASSPHRASE, prompt]
  github-ci:
    provider: github-secrets
    auth:
      method: environment
    mapping:
      DB_PASSWORD: db.password

schema:
  value.server.port: { type: number, required: true }
  value.api.baseUrl: { type: string, required: true }
  secret.db.password: { type: string, required: true }
```

## CLI Surface

| Command | What it does |
|---------|-------------|
| `cnos init` | Scaffold .cnos/ structure |
| `cnos init --mode workspace` | Scaffold with base workspace |
| `cnos read <key>` | Read a resolved value |
| `cnos value get/set <path>` | Read/write value.* keys |
| `cnos secret get/set <ref>` | Read/write secrets via vault |
| `cnos define <ns> <path> <val>` | Write to correct file via write policy |
| `cnos promote <key> --to public/env` | Add to promotion/env mapping |
| `cnos inspect <key>` | Show provenance, winner, overrides |
| `cnos validate` | Run schema + safety checks |
| `cnos export env` | Flat KEY=VALUE output |
| `cnos build server/browser/env/public` | Generate projection files |
| `cnos run [--auth] -- <cmd>` | Inject config, spawn child |
| `cnos dump` | Materialize config tree to disk |
| `cnos diff --from <p> --to <p>` | Compare profiles |
| `cnos drift` | Schema vs actual config comparison |
| `cnos doctor` | System health + security checks |
| `cnos codegen` | Generate TypeScript types from schema |
| `cnos watch -- <cmd>` | Re-resolve on file change, restart child |
| `cnos migrate` | Scan process.env usage, propose mappings |
| `cnos onboard` | Import existing .env/yaml/json/toml into CNOS |
| `cnos workspace enable` | Convert regular → workspace mode |
| `cnos workspace add <id>` | Add workspace |
| `cnos workspace detach/attach` | Standalone ↔ workspace conversion |
| `cnos vault create/list/remove` | Vault management |
| `cnos vault auth/logout` | Session authentication |
| `cnos cache list/clear/refresh` | Remote root cache management |

## Precedence Order (Lowest to Highest)

1. Global parent workspace filesystem values/secrets
2. Global active workspace filesystem values/secrets
3. Local parent workspace filesystem values/secrets
4. Local active workspace filesystem values/secrets
5. Dotenv files (from effective workspace roots)
6. Process env
7. CLI args (`--value.server.port=8080`)

Local always wins over global. Child workspace always wins over parent. Higher-precedence loader always wins over filesystem.

## Error Types

| Error | When |
|-------|------|
| `CnosDiscoveryError` | No .cnosrc.yml found, root path invalid |
| `CnosKeyNotFoundError` | `require()` on missing key |
| `CnosSecurityError` | secret.* in public.promote, sensitive namespace promoted |
| `CnosAuthenticationError` | Vault auth failed, all auth sources exhausted |
| `CnosDerivedCycleError` | Circular dependency in derived values |
| `CnosDerivedResolutionError` | Missing ref inside a derivation |
| `CnosValidationError` | Schema validation failures |
