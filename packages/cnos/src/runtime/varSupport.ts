import {
  CnosVarRequiredError,
  VarManager,
  resolveVarOverlay,
  toValueOverlayKey,
  type ConfigSpecRule,
  type DocumentSchemaDefinition,
  type IngestResult,
  type NormalizedManifest,
  type NormalizedVarSourceDefinition,
  type ProjectedVarSourceDefinition,
  type ResolvedVarSnapshot,
  type VarGroupDefinition,
  type VarSnapshotBatch,
  type VarSourceProviderModule,
} from '@kitsy/cnos-core';

export interface SingletonVarSupportOptions {
  varSources: Record<string, ProjectedVarSourceDefinition>;
  vars: Record<string, VarGroupDefinition>;
  documents: Record<string, DocumentSchemaDefinition>;
  schema: Record<string, ConfigSpecRule>;
  manifest: NormalizedManifest;
  providerModules: VarSourceProviderModule[];
  resolveSecret: (ref: string) => Promise<string>;
  /** Static value-tier reader (resolves `value.<group>.<rest>`). */
  readStaticValue: (valueKey: string) => unknown;
}

export interface SingletonVarSupport {
  manager: VarManager;
  readVar(key: string, throwIfRequired?: boolean): unknown;
  varSnapshot(key: string): ResolvedVarSnapshot;
  varSource(sourceId: string): NormalizedVarSourceDefinition | undefined;
  ingest(sourceId: string, scope: string, batch: VarSnapshotBatch): IngestResult;
  resolveSecret(ref: string): Promise<string>;
  start(): Promise<void>;
}

/**
 * Wire a {@link VarManager} into a projection-bootstrapped singleton runtime. Mirrors the core
 * `createRuntime` var wiring so projection-based apps get the same overlay/read/refresh/watch
 * behavior. Only constructed when a projection actually declares `varSources` + `vars`.
 */
export function createSingletonVarSupport(options: SingletonVarSupportOptions): SingletonVarSupport {
  const manager = new VarManager({
    varSources: options.varSources,
    vars: options.vars,
    documents: options.documents,
    schema: options.schema,
    providerModules: options.providerModules,
    resolveSecret: options.resolveSecret,
  });

  function readVar(key: string, throwIfRequired = true): unknown {
    const value = resolveVarOverlay(key, {
      readRuntimeVar: (varKey) => manager.readRuntimeVar(varKey),
      readValue: (valueKey) => options.readStaticValue(valueKey),
      manifest: options.manifest,
    });

    if (value === undefined && throwIfRequired && options.schema[key]?.required === true) {
      throw new CnosVarRequiredError(key);
    }

    return value;
  }

  function varSnapshot(key: string): ResolvedVarSnapshot {
    const runtimeSnapshot = manager.snapshot(key);

    if (runtimeSnapshot) {
      return runtimeSnapshot;
    }

    const staticValue = options.readStaticValue(toValueOverlayKey(key));

    if (staticValue !== undefined) {
      return { value: staticValue, source: 'static', freshness: 'fresh' };
    }

    return { value: options.schema[key]?.default, source: 'default', freshness: 'fresh' };
  }

  manager.setOverlayReader((key) => readVar(key, false));

  return {
    manager,
    readVar,
    varSnapshot,
    varSource: (sourceId) => options.varSources[sourceId],
    ingest: (sourceId, scope, batch) => manager.ingest(sourceId, scope, batch),
    resolveSecret: options.resolveSecret,
    async start() {
      await manager.prefetch();
      manager.startPollers();
      manager.startSubscriptions();
    },
  };
}
