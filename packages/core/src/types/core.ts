import type { NormalizedManifest } from './manifest.js';
import type { CnosPlugin } from './plugin.js';
import type { ProfileSource } from './profile.js';
import type { SecretCache } from '../secrets/secretCache.js';
import type { WorkspaceContext } from './workspace.js';
import type { ProjectedVaultDefinition, SecretReference, SecretVaultProviderFactory } from '../secrets/types.js';
import type { OverrideSpec } from './spec.js';

export type LogicalKey = string;

export type NamespaceName = string;

export interface DerivedValue {
  $derive: string | { expr: string };
}

export type ExprNode =
  | { type: 'literal'; value: string | number | boolean | null }
  | { type: 'ref'; path: string }
  | { type: 'call'; name: string; args: ExprNode[] };

export interface ParsedDerivation {
  type: 'template' | 'expression';
  raw: string;
  ast: ExprNode;
  refs: string[];
  runtimeRefs: string[];
  isRuntimeDependent: boolean;
}

export type RuntimeProvider = (key: string) => unknown;

export interface ConfigOrigin {
  file?: string;
  line?: number;
  envVar?: string;
  cliArg?: string;
}

export interface ConfigEntry {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  sourceId: string;
  pluginId: string;
  workspaceId: string;
  profile?: string;
  origin?: ConfigOrigin;
  metadata?: Record<string, unknown>;
}

export interface ResolvedEntry {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  winner: ConfigEntry;
  overridden: ConfigEntry[];
}

export interface ResolvedGraph {
  entries: Map<LogicalKey, ResolvedEntry>;
  profile: string;
  resolvedAt: string;
  profileSource: ProfileSource;
  workspace: WorkspaceContext;
}

export interface SecretResolutionContext {
  cache: SecretCache;
}

export interface InspectResult {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  profile: string;
  profileSource: ProfileSource;
  workspace: {
    id: string;
    source: WorkspaceContext['workspaceSource'];
    chain: string[];
  };
  winner: {
    sourceId: string;
    pluginId: string;
    workspaceId: string;
    origin?: ConfigOrigin;
  };
  overridden: Array<{
    sourceId: string;
    pluginId: string;
    workspaceId: string;
    value: unknown;
    origin?: ConfigOrigin;
  }>;
  derived?: {
    type: ParsedDerivation['type'];
    expression: string;
    dependencies: Array<{
      key: string;
      value: unknown;
      runtimeNamespace?: string;
    }>;
    runtimeDependent: boolean;
    runtimeNamespaces: string[];
    promotionWarning?: string;
  };
}

export interface CnosCreateOptions {
  cwd?: string;
  root?: string;
  profile?: string;
  workspace?: string;
  globalRoot?: string;
  cacheMode?: 'runtime' | 'build' | 'dev';
  cacheTtlSeconds?: number;
  forceRefresh?: boolean;
  secretResolution?: 'eager' | 'lazy' | 'refreshing';
  secretRefreshTtl?: number;
  cnosVersion?: string;
  plugins?: CnosPlugin[];
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
  /**
   * Path to a bulk patch file (JSON, YAML, or properties).
   * Keys are full logical CNOS keys (e.g. `value.server.port`).
   * Can also be set via `--cnos-patch=<path>` in `cliArgs` or the `CNOS_PATCH_FILE` env var.
   */
  patchFile?: string;
  /** Additional secret vault provider factories, usually supplied by provider packages. */
  secretVaultProviders?: SecretVaultProviderFactory[];
}

export interface ToEnvOptions {
  includeSecrets?: boolean;
}

export interface ToPublicEnvOptions {
  framework?: string;
  prefix?: string;
}

export interface DumpPlanOptions {
  flatten?: boolean;
}

export interface DumpFile {
  path: string;
  namespace: Exclude<NamespaceName, 'meta'>;
  content: string;
}

export interface DumpPlan {
  workspaceId: string;
  profile: string;
  flatten: boolean;
  files: DumpFile[];
}

export interface DumpOptions extends DumpPlanOptions {
  to: string;
}

export interface DumpResult extends DumpPlan {
  root: string;
}

export interface CnosRuntime {
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

export interface DerivedFormula {
  expr: string;
  deps: string[];
  runtimeRefs: string[];
}

export interface ServerProjection {
  version: 1;
  workspace: string;
  profile: string;
  resolvedAt: string;
  configHash: string;
  values: Record<string, unknown>;
  derived: Record<string, DerivedFormula>;
  secretRefs: Record<string, SecretReference & { envVar?: string }>;
  vaults?: Record<string, ProjectedVaultDefinition>;
  publicKeys: string[];
  runtimeNamespaces: string[];
  /** Optional format hints for value entries — e.g. { "myapp.public_key": "pem" } */
  valueTypes?: Record<string, string>;
  /** Schema-level env/arg override specs keyed by stripped value key (no "value." prefix). */
  overrides?: Record<string, OverrideSpec>;
  meta: {
    workspace: string;
    profile: string;
    cnos_version: string;
    namespaces?: string[];
  };
}
