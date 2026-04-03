import type { LogicalKey } from './core.js';
import type { ProfileResolveFrom } from './profile.js';
import type { SchemaRule } from './schema.js';

export type ResolutionArrayPolicy = 'replace' | 'append' | 'unique-append';

export interface ManifestFile {
  version?: number;
  project?: {
    name?: string;
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
  cnosRoot: string;
  manifestPath: string;
  manifest: NormalizedManifest;
  rawManifest: ManifestFile;
}
