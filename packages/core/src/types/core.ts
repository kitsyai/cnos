import type { NormalizedManifest } from './manifest.js';
import type { CnosPlugin } from './plugin.js';
import type { ProfileSource } from './profile.js';

export type LogicalKey = string;

export type NamespaceName = 'value' | 'secret' | 'meta';

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
}

export interface InspectResult {
  key: LogicalKey;
  value: unknown;
  namespace: NamespaceName;
  profile: string;
  profileSource: ProfileSource;
  winner: {
    sourceId: string;
    pluginId: string;
    origin?: ConfigOrigin;
  };
  overridden: Array<{
    sourceId: string;
    pluginId: string;
    value: unknown;
    origin?: ConfigOrigin;
  }>;
}

export interface CnosCreateOptions {
  root?: string;
  profile?: string;
  plugins?: CnosPlugin[];
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
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
}
