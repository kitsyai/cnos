import type { NamespaceName, ResolvedGraph } from '../types/core.js';
import { stripNamespace } from '../utils/path.js';

export function setNestedValue(
  target: Record<string, unknown>,
  pathSegments: string[],
  value: unknown,
): void {
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

export function toNamespaceObject(
  graph: ResolvedGraph,
  namespace?: NamespaceName,
  readValueForKey: (key: string) => unknown = (key) => graph.entries.get(key)?.value,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const resolvedEntries = Array.from(graph.entries.values()).sort((left, right) =>
    left.key.localeCompare(right.key),
  );

  for (const entry of resolvedEntries) {
    if (namespace && entry.namespace !== namespace) {
      continue;
    }

    const valuePath = namespace ? stripNamespace(entry.key) : entry.key;
    const value = readValueForKey(entry.key);

    if (value === undefined) {
      continue;
    }

    setNestedValue(output, valuePath.split('.'), value);
  }

  return output;
}
