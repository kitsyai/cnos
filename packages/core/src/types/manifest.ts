import type { LogicalKey } from './core.js';
import type { ProfileResolveFrom } from './profile.js';
import type { ConfigSpecRule } from './spec.js';
import type {
  DocumentSchemaDefinition,
  DocumentSchemaInput,
  NormalizedVarSourceDefinition,
  VarGroupDefinition,
  VarSourceDefinition,
} from './var.js';
import type { NormalizedWorkspaceItem, WorkspaceItemConfig } from './workspace.js';

export type ResolutionArrayPolicy = 'replace' | 'append' | 'unique-append';
export type NamespaceKind = 'data' | 'projection' | 'system';
export type NamespaceProjectionSource = 'promote' | 'envMapping';
export type VaultProviderName = 'local' | 'environment' | 'github-secrets' | (string & {});
export type VaultAuthMethod = 'passphrase' | 'environment' | 'token' | 'iam' | 'keychain';

export interface RuntimeNamespaceDefinition {
  description?: string;
  serverOnly: boolean;
  builtIn?: boolean;
}

export type RemoteRootProtocol = 'local' | 'git' | 'cnos';

export interface RootResolution {
  rootUri: string;
  protocol: RemoteRootProtocol;
  remote: boolean;
  readOnly: boolean;
  cacheDir?: string;
  cacheMetaPath?: string;
  ref?: string;
  subpath?: string;
  immutable?: boolean;
  resolvedCommit?: string;
  cachedAt?: string;
}

export interface ResolvedRoot {
  manifestRoot: string;
  resolution: RootResolution;
}

export interface VaultAuthSourceConfig {
  from?: string[];
}

export interface VaultAuthDefinition {
  method?: VaultAuthMethod;
  passphrase?: VaultAuthSourceConfig;
  token?: VaultAuthSourceConfig;
  config?: Record<string, unknown>;
}

export interface VaultFallbackDefinition {
  provider: VaultProviderName;
  auth?: VaultAuthDefinition;
  mapping?: Record<string, string>;
}

export interface NamespaceDefinition {
  kind: NamespaceKind;
  shareable: boolean;
  sensitive?: boolean;
  readonly?: boolean;
  source?: NamespaceProjectionSource;
}

export interface VaultDefinition {
  provider: VaultProviderName;
  auth?: VaultAuthDefinition;
  mapping?: Record<string, string>;
  fallback?: VaultFallbackDefinition[];
}

export interface ManifestFile {
  version?: number;
  project?: {
    name?: string;
  };
  workspaces?: {
    default?: string;
    global?: {
      enabled?: boolean;
      root?: string;
      allowWrite?: boolean;
    };
    items?: Record<string, WorkspaceItemConfig>;
  };
  profiles?: {
    default?: string;
    resolveFrom?: ProfileResolveFrom[];
  };
  plugins?: {
    loaders?: string[];
    resolver?: string;
    validators?: string[];
    exporters?: string[];
    inspectors?: string[];
  };
  sources?: Record<string, Record<string, unknown>>;
  resolution?: {
    precedence?: string[];
    arrayPolicy?: ResolutionArrayPolicy;
  };
  envMapping?: {
    convention?: 'SCREAMING_SNAKE';
    explicit?: Record<string, LogicalKey>;
  };
  public?: {
    promote?: LogicalKey[];
    frameworks?: Record<string, string>;
  };
  namespaces?: (Record<string, Partial<NamespaceDefinition>> & {
    runtime?: Record<
      string,
      {
        description?: string;
        server_only?: boolean;
      }
    >;
  }) | undefined;
  vaults?: Record<string, Partial<VaultDefinition>>;
  writePolicy?: {
    define?: {
      defaultProfile?: string;
      targets?: Partial<Record<'value' | 'secret', string>>;
    };
  };
  schema?: Record<LogicalKey, ConfigSpecRule>;
  /** Named runtime var sources (`var.*` distribution endpoints). */
  varSources?: Record<string, VarSourceDefinition>;
  /** Var group -> source mapping and fetch policy. */
  vars?: Record<string, VarGroupDefinition>;
  /** Document schemas keyed by `schemaId/version` (e.g. `agentic-lanes/v1`). */
  documents?: Record<string, DocumentSchemaInput>;
}

export interface NormalizedManifest {
  version: 1;
  project: {
    name: string;
  };
  workspaces: {
    default?: string;
    global: {
      enabled: boolean;
      root?: string;
      allowWrite: boolean;
    };
    items: Record<string, NormalizedWorkspaceItem>;
  };
  profiles: {
    default: string;
    resolveFrom: ProfileResolveFrom[];
  };
  plugins: {
    loaders: string[];
    resolver: string;
    validators: string[];
    exporters: string[];
    inspectors: string[];
  };
  sources: Record<string, Record<string, unknown>>;
  resolution: {
    precedence: string[];
    arrayPolicy: ResolutionArrayPolicy;
  };
  envMapping: {
    convention?: 'SCREAMING_SNAKE';
    explicit: Record<string, LogicalKey>;
  };
  public: {
    promote: LogicalKey[];
    frameworks: Record<string, string>;
  };
  namespaces: Record<string, NamespaceDefinition>;
  runtimeNamespaces: Record<string, RuntimeNamespaceDefinition>;
  vaults: Record<string, VaultDefinition>;
  writePolicy: {
    define: {
      defaultProfile: string;
      targets: Record<'value' | 'secret', string>;
    };
  };
  schema: Record<LogicalKey, ConfigSpecRule>;
  /**
   * Normalized runtime var sections. Optional on the type so manifests constructed
   * outside `normalizeManifest` (e.g. bootstrapped from a projection) stay valid;
   * `normalizeManifest` always populates them (as `{}` when absent — backward compatible).
   */
  varSources?: Record<string, NormalizedVarSourceDefinition>;
  vars?: Record<string, VarGroupDefinition>;
  documents?: Record<string, DocumentSchemaDefinition>;
}

export interface LoadManifestOptions {
  root?: string;
  cwd?: string;
  processEnv?: Record<string, string | undefined>;
  cacheMode?: 'runtime' | 'build' | 'dev';
  cacheTtlSeconds?: number;
  forceRefresh?: boolean;
}

export interface LoadedManifest {
  manifestRoot: string;
  repoRoot: string;
  consumerRoot: string;
  anchorPath?: string;
  anchoredWorkspace?: string;
  rootResolution: RootResolution;
  manifestPath: string;
  manifest: NormalizedManifest;
  rawManifest: ManifestFile;
}
