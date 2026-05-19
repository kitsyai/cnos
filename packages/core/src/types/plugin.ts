import type { ConfigEntry, InspectResult, LogicalKey, ResolvedGraph } from './core.js';
import type { NormalizedManifest } from './manifest.js';
import type { ProfileActivation } from './profile.js';
import type { ConfigSpecRule } from './spec.js';
import type { WorkspaceContext } from './workspace.js';

export type CnosPluginKind = 'loader' | 'resolver' | 'validator' | 'exporter' | 'inspector';

export interface CnosPlugin {
  id: string;
  kind: CnosPluginKind;
}

export interface LoaderContext {
  manifest: NormalizedManifest;
  manifestConfig: Record<string, unknown>;
  profile: string;
  profileChain: string[];
  profileActivation: ProfileActivation;
  manifestRoot: string;
  workspace: WorkspaceContext;
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
}

export interface ResolverContext {
  manifest: NormalizedManifest;
  profile: string;
  profileChain: string[];
  precedenceOrder: string[];
  workspace: WorkspaceContext;
}

export interface ValidationContext {
  manifest: NormalizedManifest;
  schema?: Record<LogicalKey, ConfigSpecRule>;
}

export interface ExportContext {
  manifest: NormalizedManifest;
  promotions: string[];
  frameworkPrefixes?: string[];
  workspace: WorkspaceContext;
}

export interface InspectContext {
  manifest: NormalizedManifest;
  workspace: WorkspaceContext;
}

export interface LoaderPlugin extends CnosPlugin {
  kind: 'loader';
  load(context: LoaderContext): Promise<ConfigEntry[]>;
}

export interface ResolverPlugin extends CnosPlugin {
  kind: 'resolver';
  resolve(entries: ConfigEntry[], context: ResolverContext): Promise<ResolvedGraph>;
}

export interface ValidationIssue {
  code: string;
  message: string;
  key?: LogicalKey;
}

export interface ValidationResult {
  pluginId: string;
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ValidationSummary {
  valid: boolean;
  issues: ValidationIssue[];
  results: ValidationResult[];
}

export interface ValidatorPlugin extends CnosPlugin {
  kind: 'validator';
  validate(graph: ResolvedGraph, context: ValidationContext): Promise<ValidationResult>;
}

export interface ExportResult {
  pluginId: string;
  value: Record<string, string>;
}

export interface ExporterPlugin extends CnosPlugin {
  kind: 'exporter';
  export(graph: ResolvedGraph, context: ExportContext): Promise<ExportResult>;
}

export interface InspectorPlugin extends CnosPlugin {
  kind: 'inspector';
  inspect(key: LogicalKey, graph: ResolvedGraph, context: InspectContext): Promise<InspectResult>;
}
