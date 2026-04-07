import type { LogicalKey } from './core.js';
import type { ProfileResolveFrom } from './profile.js';
import type { SchemaRule } from './schema.js';
import type { NormalizedWorkspaceItem, WorkspaceItemConfig } from './workspace.js';

export type ResolutionArrayPolicy = 'replace' | 'append' | 'unique-append';
export type NamespaceKind = 'data' | 'projection' | 'system';
export type NamespaceProjectionSource = 'promote' | 'envMapping';

export interface NamespaceDefinition {
  kind: NamespaceKind;
  shareable: boolean;
  sensitive?: boolean;
  readonly?: boolean;
  source?: NamespaceProjectionSource;
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
  namespaces?: Record<string, Partial<NamespaceDefinition>>;
  writePolicy?: {
    define?: {
      defaultProfile?: string;
      targets?: Partial<Record<'value' | 'secret', string>>;
    };
  };
  schema?: Record<LogicalKey, SchemaRule>;
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
  writePolicy: {
    define: {
      defaultProfile: string;
      targets: Record<'value' | 'secret', string>;
    };
  };
  schema: Record<LogicalKey, SchemaRule>;
}

export interface LoadManifestOptions {
  root?: string;
}

export interface LoadedManifest {
  manifestRoot: string;
  repoRoot: string;
  manifestPath: string;
  manifest: NormalizedManifest;
  rawManifest: ManifestFile;
}
