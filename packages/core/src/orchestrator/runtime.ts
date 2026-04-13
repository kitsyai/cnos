import type { CnosPlugin } from '../types/plugin.js';
import type { CnosRuntime, ResolvedGraph } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';
import { resolveSecretEntryValue } from '../secrets/batchResolve.js';
import type { SecretCache } from '../secrets/secretCache.js';
import { createDerivedRuntimeSupport, registerRuntimeProvider } from '../derive/runtime.js';
import { inspectValue } from '../runtime/inspect.js';
import { toNamespaceObject } from '../runtime/projection.js';
import { requireValue } from '../runtime/require.js';
import { createDefaultRuntimeProviders } from '../runtime/runtimeProviders.js';
import { toServerProjection } from '../runtime/toServerProjection.js';
import { toEnv } from '../runtime/toEnv.js';
import { toPublicEnv } from '../runtime/toPublicEnv.js';
import { toLogicalKey } from '../utils/path.js';
import { isSecretReference } from '../utils/secretStore.js';
import { createSecretVaultProvider } from '../secrets/providers/registry.js';
import { resolveVaultAuth } from '../secrets/resolveAuth.js';

export function createRuntime(
  manifest: NormalizedManifest,
  graph: ResolvedGraph,
  plugins: CnosPlugin[] = [],
  secretCache?: SecretCache,
  processEnv: Record<string, string | undefined> = process.env,
  cnosVersion = '0.0.0-dev',
): CnosRuntime {
  const runtimeProviders = createDefaultRuntimeProviders(manifest, processEnv);
  const derivedSupport = createDerivedRuntimeSupport(graph, manifest, runtimeProviders);

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

    if (!secretCache) {
      return;
    }

    const vaultId = entry.value.vault ?? 'default';
    const definition = manifest.vaults[vaultId] ?? {
      provider: entry.value.provider,
      auth: { passphrase: { from: [] } },
    };
    const provider = createSecretVaultProvider(vaultId, definition, processEnv);
    const auth = await resolveVaultAuth(vaultId, definition, processEnv);
    await provider.authenticate(auth);
    const value = await provider.get(entry.value.ref);

    if (value !== undefined) {
      secretCache.load(vaultId, new Map([[entry.value.ref, value]]));
    }
  }

  async function refreshAllSecrets(): Promise<void> {
    if (!secretCache) {
      return;
    }

    const secretKeys = Array.from(graph.entries.values())
      .filter((entry) => entry.namespace === 'secret' && isSecretReference(entry.value))
      .map((entry) => entry.key);

    for (const key of secretKeys) {
      await refreshSecretEntry(key);
    }
  }

  function readLogicalKey<T = unknown>(key: string): T | undefined {
    const resolved = derivedSupport.read(key, (ref) => {
      const entry = graph.entries.get(ref);

      if (!entry) {
        return undefined;
      }

      if (!secretCache) {
        return entry.value;
      }

      return resolveSecretEntryValue(ref, entry.value, secretCache);
    });

    if (resolved !== undefined || graph.entries.has(key) || manifest.runtimeNamespaces[key.split('.')[0] ?? '']) {
      return resolved as T | undefined;
    }

    const entry = graph.entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (!secretCache) {
      return entry.value as T | undefined;
    }

    return resolveSecretEntryValue(key, entry.value, secretCache) as T | undefined;
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

          if (!secretCache) {
            return entry.value;
          }

          return resolveSecretEntryValue(candidate, entry.value, secretCache);
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
