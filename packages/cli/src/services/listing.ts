import { flattenObject } from '@kitsy/cnos/internal';

import { createRuntimeService, type RuntimeServiceOptions } from './runtime.js';

export type ListNamespace = 'all' | 'value' | 'secret' | 'meta' | 'env' | 'public' | 'process';
type StoredNamespace = string;

export interface ListEntry {
  key: string;
  value: unknown;
  derived?: boolean;
}

interface StoredCandidate {
  sourceId: string;
  value: unknown;
  metadata?: Record<string, unknown>;
}

interface StoredResolvedEntry {
  key: string;
  winner: StoredCandidate;
  overridden: StoredCandidate[];
}

interface SecretListFilter {
  prefix?: string;
  vault?: string;
  provider?: string;
  framework?: string;
}

function matchesSecretFilter(candidate: StoredCandidate, filter: SecretListFilter): boolean {
  const secretRef = candidate.metadata?.secretRef as
    | {
        provider?: unknown;
        vault?: unknown;
      }
    | undefined;

  if (filter.vault && secretRef?.vault !== filter.vault) {
    return false;
  }

  if (filter.provider && secretRef?.provider !== filter.provider) {
    return false;
  }

  return true;
}

function matchesPrefix(key: string, prefix?: string): boolean {
  if (!prefix) {
    return true;
  }

  return key.startsWith(prefix) || key.split('.').slice(1).join('.').startsWith(prefix);
}

function toStoredEntry(
  namespace: StoredNamespace,
  entry: StoredResolvedEntry,
  filter: SecretListFilter = {},
): ListEntry | undefined {
  const sourceId = namespace === 'secret' ? 'filesystem-secrets' : 'filesystem-values';
  const candidates = [entry.winner, ...entry.overridden].filter((candidate) => candidate.sourceId === sourceId);

  if (candidates.length === 0) {
    return undefined;
  }

  const selectedCandidate =
    namespace === 'secret' ? candidates.find((candidate) => matchesSecretFilter(candidate, filter)) : candidates[0];

  if (!selectedCandidate) {
    return undefined;
  }

  return {
    key: entry.key,
    value: selectedCandidate.value,
    ...(typeof selectedCandidate.value === 'object' &&
    selectedCandidate.value !== null &&
    !Array.isArray(selectedCandidate.value) &&
    '$derive' in selectedCandidate.value
      ? {
          derived: true,
        }
      : {}),
  };
}

async function listStoredNamespace(
  namespace: StoredNamespace,
  options: RuntimeServiceOptions & SecretListFilter,
): Promise<ListEntry[]> {
  const runtime = await createRuntimeService(options);

  return Array.from(runtime.graph.entries.values())
    .filter((entry) => entry.namespace === namespace)
    .map((entry) => {
      const stored = toStoredEntry(namespace, entry, options);

      if (!stored) {
        return undefined;
      }

      return {
        ...stored,
        value: stored.derived ? runtime.read(entry.key) : stored.value,
      };
    })
    .filter((entry): entry is ListEntry => Boolean(entry))
    .filter((entry) => entry.value !== undefined)
    .filter((entry) => matchesPrefix(entry.key, options.prefix))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function listProjectedNamespace(
  namespace: 'meta' | 'env' | 'public' | 'process',
  options: RuntimeServiceOptions & { prefix?: string; framework?: string },
): Promise<ListEntry[]> {
  return createRuntimeService(options).then((runtime) => {
    const projected =
      namespace === 'meta'
        ? flattenObject(runtime.toNamespace('meta'))
        : namespace === 'env'
          ? runtime.toEnv()
          : namespace === 'public'
            ? runtime.toPublicEnv({
                ...(options.framework
                  ? {
                      framework: options.framework,
                    }
                  : {}),
              })
            : flattenObject(runtime.toNamespace(namespace));

    const entries =
      namespace === 'env'
        ? Object.entries(projected).map(([envVar, value]) => ({
            key: envVar,
            value,
          }))
        : Object.entries(projected).map(([key, value]) => ({
            key: namespace === 'meta' || namespace === 'process' ? `${namespace}.${key}` : key,
            value,
          }));

    return entries
      .filter((entry) => entry.value !== undefined)
      .filter((entry) => matchesPrefix(entry.key, options.prefix))
      .sort((left, right) => left.key.localeCompare(right.key));
  });
}

export async function listConfigEntries(
  namespace: ListNamespace | string,
  options: RuntimeServiceOptions & { prefix?: string; framework?: string } = {},
): Promise<ListEntry[]> {
  if (namespace === 'value' || namespace === 'secret') {
    return listStoredNamespace(namespace, options);
  }

  if (namespace === 'meta' || namespace === 'env' || namespace === 'public' || namespace === 'process') {
    return listProjectedNamespace(namespace, options);
  }

  if (namespace !== 'all') {
    return listStoredNamespace(namespace, options);
  }

  const runtime = await createRuntimeService(options);
  const namespaces = Array.from(
    new Set(
      Array.from(runtime.graph.entries.values())
        .map((entry) => entry.namespace)
        .filter((entry) => entry !== 'meta' && entry !== 'env' && entry !== 'public'),
    ),
  ).sort((left, right) => left.localeCompare(right));

  const stored = await Promise.all(namespaces.map((entry) => listStoredNamespace(entry, options)));
  const meta = await listProjectedNamespace('meta', options);

  return [...stored.flat(), ...meta].sort((left, right) => left.key.localeCompare(right.key));
}
