import { flattenObject } from '@kitsy/cnos/internal';

import { maskSecretValue } from '../format/maskSecret.js';
import { applyMaskedSecretEnvMappings, getSecretEnvMappings, hydrateSecretEnvMappings } from './secretEnvBuild.js';
import { createRuntimeService, type RuntimeServiceOptions } from './runtime.js';

export type ListNamespace = 'all' | 'value' | 'secret' | 'meta' | 'env' | 'public' | 'process';
type StoredNamespace = string;

export interface ListEntry {
  key: string;
  value: unknown;
  derived?: boolean;
  vault?: string;
  provider?: string;
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
    ...(namespace === 'secret'
      ? {
          vault: (selectedCandidate.metadata?.secretRef as { vault?: string } | undefined)?.vault ?? 'default',
          provider: (selectedCandidate.metadata?.secretRef as { provider?: string } | undefined)?.provider ?? 'local',
        }
      : {}),
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
  const runtime = await createRuntimeService({
    ...options,
    ...(namespace === 'secret' ? { secretResolution: 'lazy' as const } : {}),
  });
  const revealSecrets = namespace === 'secret' && (options.cliArgs?.includes('--reveal') ?? false);

  const results: ListEntry[] = [];

  for (const entry of Array.from(runtime.graph.entries.values()).filter((candidate) => candidate.namespace === namespace)) {
    const stored = toStoredEntry(namespace, entry, options);

    if (!stored) {
      continue;
    }

    const value =
      namespace === 'secret'
        ? revealSecrets
          ? (await runtime.refreshSecret(entry.key), runtime.secret(entry.key.slice('secret.'.length)))
          : maskSecretValue(stored.value)
        : stored.derived
          ? runtime.read(entry.key)
          : stored.value;

    if (value === undefined || !matchesPrefix(stored.key, options.prefix)) {
      continue;
    }

    results.push({
      ...stored,
      value,
    });
  }

  return results.sort((left, right) => left.key.localeCompare(right.key));
}

function listProjectedNamespace(
  namespace: 'meta' | 'env' | 'public' | 'process',
  options: RuntimeServiceOptions & { prefix?: string; framework?: string; vault?: string; provider?: string },
): Promise<ListEntry[]> {
  return createRuntimeService({
    ...options,
    ...(namespace === 'env' ? { secretResolution: 'lazy' as const } : {}),
  }).then(async (runtime) => {
    const revealSecrets = options.cliArgs?.includes('--reveal') ?? false;
    const secretMappings = namespace === 'env' ? getSecretEnvMappings(runtime) : [];

    if (namespace === 'env' && revealSecrets && secretMappings.length > 0) {
      await hydrateSecretEnvMappings(runtime, secretMappings);
    }

    const projected =
      namespace === 'meta'
        ? flattenObject(runtime.toNamespace('meta'))
        : namespace === 'env'
          ? revealSecrets
            ? runtime.toEnv({ includeSecrets: true })
            : applyMaskedSecretEnvMappings(runtime.toEnv(), secretMappings)
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
  options: RuntimeServiceOptions & { prefix?: string; framework?: string; vault?: string; provider?: string } = {},
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
