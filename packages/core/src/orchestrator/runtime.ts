import type { CnosPlugin } from '../types/plugin.js';
import type { CnosRuntime, ResolvedGraph } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';
import type { SecretVaultProviderFactory } from '../secrets/types.js';
import { batchResolveSecrets, resolveSecretEntryValue } from '../secrets/batchResolve.js';
import type { SecretCache } from '../secrets/secretCache.js';
import { createDerivedRuntimeSupport, registerRuntimeProvider } from '../derive/runtime.js';
import { inspectValue } from '../runtime/inspect.js';
import { toNamespaceObject } from '../runtime/projection.js';
import { requireValue } from '../runtime/require.js';
import { createDefaultRuntimeProviders } from '../runtime/runtimeProviders.js';
import { toServerProjection } from '../runtime/toServerProjection.js';
import { toEnv } from '../runtime/toEnv.js';
import { toPublicEnv } from '../runtime/toPublicEnv.js';
import {
  buildOverrideMap,
  CNOS_PATCH_FILE_ENV,
  CNOS_PATCH_FLAG,
  loadPatchFile,
  parseCliArgs,
  resolveOverride,
} from '../runtime/overrideResolver.js';
import { isVarKey, resolveVarOverlay, toValueOverlayKey } from '../runtime/readVar.js';
import { VarManager } from '../runtime/varManager.js';
import type { ResolvedVarSnapshot, VarSourceProviderModule } from '../types/var.js';
import { toLogicalKey } from '../utils/path.js';
import { isSecretReference } from '../utils/secretStore.js';
import { CnosKeyNotFoundError, CnosVarRequiredError } from '../errors.js';

export function createRuntime(
  manifest: NormalizedManifest,
  graph: ResolvedGraph,
  plugins: CnosPlugin[] = [],
  secretCache?: SecretCache,
  processEnv: Record<string, string | undefined> = process.env,
  cnosVersion = '0.0.0-dev',
  secretVaultProviders: SecretVaultProviderFactory[] = [],
  cliArgs?: string[],
  patchFile?: string,
  varSourceProviders: VarSourceProviderModule[] = [],
): CnosRuntime {
  const runtimeProviders = createDefaultRuntimeProviders(manifest, processEnv);
  const derivedSupport = createDerivedRuntimeSupport(graph, manifest, runtimeProviders);
  const overrideMap = buildOverrideMap(manifest.schema);
  const argsMap = parseCliArgs(cliArgs ?? process.argv.slice(2));
  const resolvedPatchFile =
    patchFile ?? argsMap.get(CNOS_PATCH_FLAG) ?? processEnv[CNOS_PATCH_FILE_ENV] ?? undefined;
  const patchValues: Map<string, unknown> = resolvedPatchFile
    ? loadPatchFile(resolvedPatchFile)
    : new Map();
  let activeSecretCache = secretCache;

  function resolveProjectedSourceKey(key: string): string {
    if (!key.startsWith('public.')) {
      return key;
    }

    const promotedFrom = graph.entries.get(key)?.winner.metadata?.promotedFrom;

    if (typeof promotedFrom === 'string') {
      return promotedFrom;
    }

    const fallback = `value.${key.slice('public.'.length)}`;
    return graph.entries.has(fallback) ? fallback : key;
  }

  async function refreshSecretEntry(key: string): Promise<void> {
    const entry = graph.entries.get(key);

    if (!entry || entry.namespace !== 'secret' || !isSecretReference(entry.value)) {
      return;
    }

    if (!activeSecretCache) {
      return;
    }

    const vaultId = entry.value.vault ?? 'default';
    const refreshed = await batchResolveSecrets(
      {
        ...graph,
        entries: new Map([[key, entry]]),
      },
      manifest,
      processEnv,
      secretVaultProviders,
    );
    const resolved = refreshed.get(vaultId, entry.value.ref);
    const existing = activeSecretCache.entriesForVault(vaultId);

    existing.delete(entry.value.ref);
    if (resolved !== undefined) {
      existing.set(entry.value.ref, resolved);
    }
    activeSecretCache.replace(vaultId, existing);
  }

  async function refreshAllSecrets(): Promise<void> {
    if (!activeSecretCache) {
      return;
    }

    const refreshed = await batchResolveSecrets(
      graph,
      manifest,
      processEnv,
      secretVaultProviders,
    );
    activeSecretCache = refreshed;
  }

  async function resolveVarSecret(ref: string): Promise<string> {
    const value = readLogicalKey(ref);

    if (value === undefined) {
      throw new Error(`Cannot resolve var source auth secret "${ref}".`);
    }

    return typeof value === 'string' ? value : String(value);
  }

  const hasVarRuntime =
    !!manifest.varSources &&
    !!manifest.vars &&
    Object.keys(manifest.varSources).length > 0 &&
    Object.keys(manifest.vars).length > 0;

  const varManager = hasVarRuntime
    ? new VarManager({
        varSources: manifest.varSources ?? {},
        vars: manifest.vars ?? {},
        documents: manifest.documents ?? {},
        schema: manifest.schema,
        providerModules: varSourceProviders,
        resolveSecret: resolveVarSecret,
      })
    : undefined;

  function readLogicalKeyCore<T = unknown>(key: string): T | undefined {
    const resolved = derivedSupport.read(key, (ref) => {
      if (isVarKey(ref)) {
        return readVarKey(ref, false);
      }

      const entry = graph.entries.get(ref);

      if (!entry) {
        return undefined;
      }

      if (!activeSecretCache) {
        return entry.value;
      }

      return resolveSecretEntryValue(ref, entry.value, activeSecretCache);
    });

    if (resolved !== undefined || graph.entries.has(key) || manifest.runtimeNamespaces[key.split('.')[0] ?? '']) {
      return resolved as T | undefined;
    }

    const entry = graph.entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (!activeSecretCache) {
      return entry.value as T | undefined;
    }

    return resolveSecretEntryValue(key, entry.value, activeSecretCache) as T | undefined;
  }

  function readLogicalKey<T = unknown>(key: string): T | undefined {
    if (key.startsWith('value.') && overrideMap.size > 0) {
      const strippedKey = key.slice('value.'.length);
      const spec = overrideMap.get(strippedKey);
      if (spec) {
        // Patch file participates as the "cnos" source: if the file has a value,
        // it supersedes the CNOS graph value but still loses to arg/env.
        return resolveOverride(spec, () => {
          const pv = patchValues.get(key);
          return pv !== undefined ? pv : readLogicalKeyCore(key);
        }, argsMap, processEnv, key) as T | undefined;
      }
    }
    // No OverrideSpec — patch then CNOS
    const pv = patchValues.get(key);
    if (pv !== undefined) return pv as T;
    return readLogicalKeyCore(key);
  }

  function readVarKey<T = unknown>(key: string, throwIfRequired = true): T | undefined {
    const value = resolveVarOverlay(key, {
      // Runtime tier: the live var store (undefined when no var runtime is configured). The
      // overlay then falls through to the static value tier and the schema default.
      ...(varManager ? { readRuntimeVar: (varKey) => varManager.readRuntimeVar(varKey) } : {}),
      readValue: (valueKey) => readLogicalKey(valueKey),
      manifest,
    }) as T | undefined;

    if (value === undefined && throwIfRequired && manifest.schema[key]?.required === true) {
      throw new CnosVarRequiredError(key);
    }

    return value;
  }

  /**
   * The NON-runtime tiers only (② static → ③ default). Kept separate from
   * {@link varSnapshotForKey} so the var store can ask "what does this key fall back to?"
   * without re-entering the runtime tier it is in the middle of mutating.
   */
  function fallbackVarSnapshot(key: string): ResolvedVarSnapshot {
    const staticValue = readLogicalKey(toValueOverlayKey(key));

    if (staticValue !== undefined) {
      return { value: staticValue, source: 'static', freshness: 'fresh' };
    }

    return { value: manifest.schema[key]?.default, source: 'default', freshness: 'fresh' };
  }

  function varSnapshotForKey(key: string): ResolvedVarSnapshot {
    const runtimeSnapshot = varManager?.snapshot(key);

    if (runtimeSnapshot) {
      return runtimeSnapshot;
    }

    return fallbackVarSnapshot(key);
  }

  const runtime: CnosRuntime = {
    manifest,
    plugins,
    graph,
    read(key) {
      return isVarKey(key) ? readVarKey(key) : readLogicalKey(key);
    },
    require<T = unknown>(key: string) {
      if (isVarKey(key)) {
        const varValue = readVarKey<T>(key);

        if (varValue === undefined) {
          throw new CnosKeyNotFoundError(key);
        }

        return varValue;
      }

      const value = readLogicalKey(key);

      if (value === undefined) {
        return requireValue<T>(graph, key);
      }

      return value as T;
    },
    readOr(key, fallback) {
      const value = isVarKey(key) ? readVarKey(key, false) : readLogicalKey(key);
      return (value === undefined ? fallback : value) as typeof fallback;
    },
    value(path) {
      return readLogicalKey(toLogicalKey('value', path));
    },
    secret(path) {
      return readLogicalKey(toLogicalKey('secret', path));
    },
    var(path) {
      return readVarKey(toLogicalKey('var', path));
    },
    varSnapshot(path) {
      return varSnapshotForKey(toLogicalKey('var', path));
    },
    varStatus() {
      return varManager?.status() ?? {};
    },
    async refreshVar(key) {
      await varManager?.refreshVar(key);
    },
    async refreshVars() {
      await varManager?.refreshVars();
    },
    watch(keyOrPrefix, callback) {
      return varManager?.watch(keyOrPrefix, callback) ?? (() => undefined);
    },
    async close() {
      await varManager?.close();
    },
    meta(path) {
      return readLogicalKey(toLogicalKey('meta', path));
    },
    inspect(key) {
      return inspectValue(graph, key, {
        read: (ref) => readLogicalKey(ref),
        describeDerived: (ref) => derivedSupport.describe(ref, (candidate) => {
          const entry = graph.entries.get(candidate);

          if (!entry) {
            return undefined;
          }

          if (!activeSecretCache) {
            return entry.value;
          }

          return resolveSecretEntryValue(candidate, entry.value, activeSecretCache);
        }),
      });
    },
    toObject() {
      return toNamespaceObject(graph, undefined, (key) => readLogicalKey(key));
    },
    toNamespace(namespace) {
      return toNamespaceObject(graph, namespace, (key) => readLogicalKey(key));
    },
    toEnv(options) {
      return toEnv(graph, manifest, options, {
        read: (key) => readLogicalKey(key),
        isRuntimeDependent: (key) => derivedSupport.isRuntimeDependentKey(key),
      });
    },
    toPublicEnv(options) {
      return toPublicEnv(graph, manifest, options, {
        read: (key) =>
          derivedSupport.toConcreteValue(
            resolveProjectedSourceKey(key),
            (candidate) => readLogicalKey(candidate),
            'public',
          ),
        isRuntimeDependent: (key) => derivedSupport.isRuntimeDependentKey(resolveProjectedSourceKey(key)),
      });
    },
    toServerProjection(opts) {
      return toServerProjection(graph, manifest, cnosVersion, {
        read: (key) => derivedSupport.toConcreteValue(key, (candidate) => readLogicalKey(candidate), 'server'),
        isRuntimeDependent: (key) => derivedSupport.isRuntimeDependentKey(key),
        toServerFormula: (key) => derivedSupport.toServerFormula(key),
      }, opts);
    },
    registerRuntimeProvider(namespace, provider) {
      registerRuntimeProvider(manifest, runtimeProviders, namespace, provider);
    },
    async refreshSecrets() {
      await refreshAllSecrets();
    },
    async refreshSecret(key) {
      await refreshSecretEntry(key);
    },
  };

  if (varManager) {
    varManager.setOverlayReader((key) => readVarKey(key, false));
    varManager.setFallbackSnapshotReader((key) => fallbackVarSnapshot(key));
    // Internal hook awaited by createCnos during ready(). Transactional: a failed attempt rolls
    // back any timers/subscriptions it created so a retry cannot duplicate them.
    Object.defineProperty(runtime, '__startVars', {
      value: async () => {
        await varManager.start();
      },
      enumerable: false,
    });
    // Internal hook used by the push receiver to route inbound batches through ingest.
    Object.defineProperty(runtime, '__ingestVar', {
      value: (sourceId: string, scope: string, batch: unknown) =>
        varManager.ingest(sourceId, scope, batch as never),
      enumerable: false,
    });
    Object.defineProperty(runtime, '__varSource', {
      value: (sourceId: string) => manifest.varSources?.[sourceId],
      enumerable: false,
    });
    Object.defineProperty(runtime, '__resolveVarSecret', {
      value: (ref: string) => resolveVarSecret(ref),
      enumerable: false,
    });
  }

  return runtime;
}
