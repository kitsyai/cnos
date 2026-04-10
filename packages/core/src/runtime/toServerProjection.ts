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
): ServerProjection {
  const values: Record<string, unknown> = {};
  const secretRefs: ServerProjection['secretRefs'] = {};
  const namespaces = new Set<string>();
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
      values[stripValuePrefix(key)] = entry.value;
      continue;
    }

    const namespaceDefinition = manifest.namespaces[entry.namespace];

    if (
      namespaceDefinition &&
      namespaceDefinition.kind === 'data' &&
      !namespaceDefinition.sensitive &&
      entry.namespace !== 'public'
    ) {
      values[key] = entry.value;
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
    secretRefs: stableSortObject(secretRefs) as ServerProjection['secretRefs'],
    publicKeys,
    meta: {
      workspace: graph.workspace.workspaceId,
      profile: graph.profile,
      cnos_version: cnosVersion,
      ...(namespaces.size > 0 ? { namespaces: Array.from(namespaces).sort((left, right) => left.localeCompare(right)) } : {}),
    },
  };
}
