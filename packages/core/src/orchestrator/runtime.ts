import type { CnosPlugin } from '../types/plugin.js';
import type { CnosRuntime, ResolvedGraph } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';
import { inspectValue } from '../runtime/inspect.js';
import { toNamespaceObject } from '../runtime/projection.js';
import { readOrValue } from '../runtime/readOr.js';
import { readValue } from '../runtime/read.js';
import { requireValue } from '../runtime/require.js';
import { toEnv } from '../runtime/toEnv.js';
import { toPublicEnv } from '../runtime/toPublicEnv.js';
import { toLogicalKey } from '../utils/path.js';

export function createRuntime(
  manifest: NormalizedManifest,
  graph: ResolvedGraph,
  plugins: CnosPlugin[] = [],
): CnosRuntime {
  return {
    manifest,
    plugins,
    graph,
    read(key) {
      return readValue(graph, key);
    },
    require(key) {
      return requireValue(graph, key);
    },
    readOr(key, fallback) {
      return readOrValue(graph, key, fallback);
    },
    value(path) {
      return readValue(graph, toLogicalKey('value', path));
    },
    secret(path) {
      return readValue(graph, toLogicalKey('secret', path));
    },
    meta(path) {
      return readValue(graph, toLogicalKey('meta', path));
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
