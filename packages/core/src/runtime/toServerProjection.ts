import { createHash } from 'node:crypto';

import type { ResolvedGraph, ServerProjection } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';
import { isSecretReference } from '../utils/secretStore.js';

function stableSortObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function stripValuePrefix(key: string): string {
  return key.startsWith('value.') ? key.slice('value.'.length) : key;
}

function configHash(values: Record<string, unknown>): string {
  const serialized = JSON.stringify(stableSortObject(values));
  return createHash('sha256').update(serialized).digest('hex');
}

export function toServerProjection(
  graph: ResolvedGraph,
  manifest: NormalizedManifest,
  cnosVersion = '0.0.0-dev',
  helpers: {
    read?: (key: string) => unknown;
    isRuntimeDependent?: (key: string) => boolean;
    toServerFormula?: (key: string) => ServerProjection['derived'][string] | undefined;
  } = {},
): ServerProjection {
  const values: Record<string, unknown> = {};
  const derived: ServerProjection['derived'] = {};
  const secretRefs: ServerProjection['secretRefs'] = {};
  const namespaces = new Set<string>();
  const runtimeNamespaces = new Set<string>();
  const publicKeys = Array.from(graph.entries.values())
    .filter((entry) => entry.namespace === 'public')
    .map((entry) => entry.key.slice('public.'.length))
    .sort((left, right) => left.localeCompare(right));

  for (const [key, entry] of graph.entries) {
    if (entry.namespace === 'secret' && isSecretReference(entry.value)) {
      secretRefs[key.slice('secret.'.length)] = {
        provider: entry.value.provider,
        vault: entry.value.vault ?? 'default',
        ref: entry.value.ref,
      };
      continue;
    }

    if (entry.namespace === 'value') {
      if (helpers.isRuntimeDependent?.(key)) {
        const formula = helpers.toServerFormula?.(key);

        if (formula) {
          derived[stripValuePrefix(key)] = formula;
          for (const ref of formula.runtimeRefs) {
            runtimeNamespaces.add(ref.split('.')[0] ?? '');
          }
        }
        continue;
      }

      const value = helpers.read ? helpers.read(key) : entry.value;
      values[stripValuePrefix(key)] = value;
      continue;
    }

    const namespaceDefinition = manifest.namespaces[entry.namespace];

    if (
      namespaceDefinition &&
      namespaceDefinition.kind === 'data' &&
      !namespaceDefinition.sensitive &&
      entry.namespace !== 'public'
    ) {
      if (helpers.isRuntimeDependent?.(key)) {
        const formula = helpers.toServerFormula?.(key);

        if (formula) {
          derived[key] = formula;
          for (const ref of formula.runtimeRefs) {
            runtimeNamespaces.add(ref.split('.')[0] ?? '');
          }
        }
        continue;
      }

      values[key] = helpers.read ? helpers.read(key) : entry.value;
      namespaces.add(entry.namespace);
    }
  }

  return {
    version: 1,
    workspace: graph.workspace.workspaceId,
    profile: graph.profile,
    resolvedAt: graph.resolvedAt,
    configHash: configHash(values),
    values: stableSortObject(values),
    derived: stableSortObject(derived) as ServerProjection['derived'],
    secretRefs: stableSortObject(secretRefs) as ServerProjection['secretRefs'],
    publicKeys,
    runtimeNamespaces: Array.from(runtimeNamespaces).sort((left, right) => left.localeCompare(right)),
    meta: {
      workspace: graph.workspace.workspaceId,
      profile: graph.profile,
      cnos_version: cnosVersion,
      ...(namespaces.size > 0 ? { namespaces: Array.from(namespaces).sort((left, right) => left.localeCompare(right)) } : {}),
    },
  };
}
