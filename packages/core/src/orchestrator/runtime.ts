import type { CnosPlugin } from '../types/plugin.js';
import type { CnosRuntime, NamespaceName, ResolvedGraph } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';
import { inspectValue } from '../runtime/inspect.js';
import { readOrValue } from '../runtime/readOr.js';
import { readValue } from '../runtime/read.js';
import { requireValue } from '../runtime/require.js';
import { stripNamespace, toLogicalKey } from '../utils/path.js';

function setNestedValue(target: Record<string, unknown>, pathSegments: string[], value: unknown): void {
  const [head, ...tail] = pathSegments;

  if (!head) {
    return;
  }

  if (tail.length === 0) {
    target[head] = value;
    return;
  }

  const current = target[head];
  const nextTarget =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  target[head] = nextTarget;
  setNestedValue(nextTarget, tail, value);
}

function toNamespaceObject(graph: ResolvedGraph, namespace?: NamespaceName): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const entry of graph.entries.values()) {
    if (namespace && entry.namespace !== namespace) {
      continue;
    }

    const path = namespace ? stripNamespace(entry.key) : entry.key;
    setNestedValue(output, path.split('.'), entry.value);
  }

  return output;
}

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
  };
}
