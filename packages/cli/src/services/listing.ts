import { flattenObject } from '@kitsy/cnos/internal';

import { createRuntimeService, type RuntimeServiceOptions } from './runtime.js';

export type ListNamespace = 'all' | 'value' | 'secret' | 'meta' | 'env' | 'public';

export interface ListEntry {
  key: string;
  value: unknown;
}

interface StoredResolvedEntry {
  key: string;
  winner: {
    sourceId: string;
    value: unknown;
  };
  overridden: Array<{
    sourceId: string;
    value: unknown;
  }>;
}

function matchesPrefix(key: string, prefix?: string): boolean {
  if (!prefix) {
    return true;
  }

  return key.startsWith(prefix) || key.split('.').slice(1).join('.').startsWith(prefix);
}

function toStoredEntry(namespace: 'value' | 'secret', entry: StoredResolvedEntry): ListEntry | undefined {
  const sourceId = namespace === 'value' ? 'filesystem-values' : 'filesystem-secrets';
  const candidates = [entry.winner, ...entry.overridden].filter((candidate) => candidate.sourceId === sourceId);

  if (candidates.length === 0) {
    return undefined;
  }

  return {
    key: entry.key,
    value: candidates[0]?.value,
  };
}

function listStoredNamespace(
  namespace: 'value' | 'secret',
  options: RuntimeServiceOptions & { prefix?: string },
): Promise<ListEntry[]> {
  return createRuntimeService(options).then((runtime) =>
    Array.from(runtime.graph.entries.values())
      .filter((entry) => entry.namespace === namespace)
      .map((entry) => toStoredEntry(namespace, entry))
      .filter((entry): entry is ListEntry => Boolean(entry))
      .filter((entry) => matchesPrefix(entry.key, options.prefix))
      .sort((left, right) => left.key.localeCompare(right.key)),
  );
}

function listProjectedNamespace(
  namespace: 'meta' | 'env' | 'public',
  options: RuntimeServiceOptions & { prefix?: string },
): Promise<ListEntry[]> {
  return createRuntimeService(options).then((runtime) => {
    const projected =
      namespace === 'meta'
        ? flattenObject(runtime.toNamespace('meta'))
        : namespace === 'env'
          ? runtime
              .manifest.envMapping.explicit
          : runtime.toPublicEnv();

    const entries =
      namespace === 'env'
        ? Object.entries(projected).map(([envVar, logicalKey]) => ({
            key: envVar,
            value: runtime.read(logicalKey as string),
          }))
        : Object.entries(projected).map(([key, value]) => ({
            key: namespace === 'meta' ? `meta.${key}` : key,
            value,
          }));

    return entries
      .filter((entry) => entry.value !== undefined)
      .filter((entry) => matchesPrefix(entry.key, options.prefix))
      .sort((left, right) => left.key.localeCompare(right.key));
  });
}

export async function listConfigEntries(
  namespace: ListNamespace,
  options: RuntimeServiceOptions & { prefix?: string } = {},
): Promise<ListEntry[]> {
  if (namespace === 'value' || namespace === 'secret') {
    return listStoredNamespace(namespace, options);
  }

  if (namespace === 'meta' || namespace === 'env' || namespace === 'public') {
    return listProjectedNamespace(namespace, options);
  }

  const [values, secrets, meta] = await Promise.all([
    listStoredNamespace('value', options),
    listStoredNamespace('secret', options),
    listProjectedNamespace('meta', options),
  ]);

  return [...values, ...secrets, ...meta].sort((left, right) => left.key.localeCompare(right.key));
}
