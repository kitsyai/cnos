import type { ResolvedGraph } from '@kitsy/cnos-core';

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

export function diffGraphs(previous: ResolvedGraph, next: ResolvedGraph): string[] {
  const keys = new Set([
    ...Array.from(previous.entries.keys()),
    ...Array.from(next.entries.keys()),
  ]);

  return Array.from(keys)
    .filter((key) => !key.startsWith('meta.'))
    .filter((key) => {
      const previousEntry = previous.entries.get(key);
      const nextEntry = next.entries.get(key);

      if (!previousEntry || !nextEntry) {
        return previousEntry?.namespace !== 'meta' && nextEntry?.namespace !== 'meta';
      }

      return stableStringify(previousEntry.value) !== stableStringify(nextEntry.value);
    })
    .sort((left, right) => left.localeCompare(right));
}
