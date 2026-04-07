import type { NormalizedManifest } from './manifest.js';
import type { CnosPlugin } from './plugin.js';
import type { ProfileSource } from './profile.js';
import type { WorkspaceContext } from './workspace.js';

export type LogicalKey = string;

export type NamespaceName = string;

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
}

export interface CnosCreateOptions {
  root?: string;
  profile?: string;
  workspace?: string;
  globalRoot?: string;
  cnosVersion?: string;
  plugins?: CnosPlugin[];
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
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
}
