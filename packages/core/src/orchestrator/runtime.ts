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
  CNOS_OVERRIDE_FILE_ENV,
  CNOS_OVERRIDE_FLAG,
  loadOverrideFile,
  parseCliArgs,
  resolveOverride,
} from '../runtime/overrideResolver.js';
import { toLogicalKey } from '../utils/path.js';
import { isSecretReference } from '../utils/secretStore.js';

export function createRuntime(
  manifest: NormalizedManifest,
  graph: ResolvedGraph,
  plugins: CnosPlugin[] = [],
  secretCache?: SecretCache,
  processEnv: Record<string, string | undefined> = process.env,
  cnosVersion = '0.0.0-dev',
  secretVaultProviders: SecretVaultProviderFactory[] = [],
  cliArgs?: string[],
  overrideFile?: string,
): CnosRuntime {
  const runtimeProviders = createDefaultRuntimeProviders(manifest, processEnv);
  const derivedSupport = createDerivedRuntimeSupport(graph, manifest, runtimeProviders);
  const overrideMap = buildOverrideMap(manifest.schema);
  const argsMap = parseCliArgs(cliArgs ?? process.argv.slice(2));
  const resolvedOverrideFile =
    overrideFile ?? argsMap.get(CNOS_OVERRIDE_FLAG) ?? processEnv[CNOS_OVERRIDE_FILE_ENV] ?? undefined;
  const fileOverrides: Map<string, unknown> = resolvedOverrideFile
    ? loadOverrideFile(resolvedOverrideFile)
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
        // File override participates as the "cnos" source: if the file has a value,
        // it supersedes the CNOS graph value but still loses to arg/env.
        return resolveOverride(spec, () => {
          const fv = fileOverrides.get(key);
          return fv !== undefined ? fv : readLogicalKeyCore(key);
        }, argsMap, processEnv) as T | undefined;
      }
    }
    // No OverrideSpec — file then CNOS
    const fv = fileOverrides.get(key);
    if (fv !== undefined) return fv as T;
    return readLogicalKeyCore(key);
  }

  return {
    manifest,
    plugins,
    graph,
    read(key) {
      return readLogicalKey(key);
    },
    require<T = unknown>(key: string) {
      const value = readLogicalKey(key);

      if (value === undefined) {
        return requireValue<T>(graph, key);
      }

      return value as T;
    },
    readOr(key, fallback) {
      const value = readLogicalKey(key);
      return (value === undefined ? fallback : value) as typeof fallback;
    },
    value(path) {
      return readLogicalKey(toLogicalKey('value', path));
    },
    secret(path) {
      return readLogicalKey(toLogicalKey('secret', path));
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
    toServerProjection() {
      return toServerProjection(graph, manifest, cnosVersion, {
        read: (key) => derivedSupport.toConcreteValue(key, (candidate) => readLogicalKey(candidate), 'server'),
        isRuntimeDependent: (key) => derivedSupport.isRuntimeDependentKey(key),
        toServerFormula: (key) => derivedSupport.toServerFormula(key),
      });
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
