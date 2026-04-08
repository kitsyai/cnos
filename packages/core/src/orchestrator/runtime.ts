import type { CnosPlugin } from '../types/plugin.js';
import type { CnosRuntime, ResolvedGraph } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';
import { resolveSecretEntryValue } from '../secrets/batchResolve.js';
import type { SecretCache } from '../secrets/secretCache.js';
import { inspectValue } from '../runtime/inspect.js';
import { toNamespaceObject } from '../runtime/projection.js';
import { readOrValue } from '../runtime/readOr.js';
import { requireValue } from '../runtime/require.js';
import { toEnv } from '../runtime/toEnv.js';
import { toPublicEnv } from '../runtime/toPublicEnv.js';
import { toLogicalKey } from '../utils/path.js';

export function createRuntime(
  manifest: NormalizedManifest,
  graph: ResolvedGraph,
  plugins: CnosPlugin[] = [],
  secretCache?: SecretCache,
): CnosRuntime {
  function readLogicalKey<T = unknown>(key: string): T | undefined {
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
      return readOrValue(graph, key, fallback);
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
      return inspectValue(graph, key);
    },
    toObject() {
      return toNamespaceObject(graph);
    },
    toNamespace(namespace) {
      return toNamespaceObject(graph, namespace);
    },
    toEnv(options) {
      return toEnv(graph, manifest, options);
    },
    toPublicEnv(options) {
      return toPublicEnv(graph, manifest, options);
    },
  };
}
