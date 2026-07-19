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
import { isVarKey, resolveVarOverlay } from '../runtime/readVar.js';
import { toLogicalKey } from '../utils/path.js';
import { isSecretReference } from '../utils/secretStore.js';
import { CnosKeyNotFoundError } from '../errors.js';

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

  function readLogicalKeyCore<T = unknown>(key: string): T | undefined {
    const resolved = derivedSupport.read(key, (ref) => {
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

  function readVarKey<T = unknown>(key: string): T | undefined {
    return resolveVarOverlay(key, {
      // W1: no runtime tier. readRuntimeVar is intentionally omitted; W3 wires the live
      // var store here. Overlay falls through to the static value tier and schema default.
      readValue: (valueKey) => readLogicalKey(valueKey),
      manifest,
    }) as T | undefined;
  }

  return {
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
      const value = isVarKey(key) ? readVarKey(key) : readLogicalKey(key);
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
}
