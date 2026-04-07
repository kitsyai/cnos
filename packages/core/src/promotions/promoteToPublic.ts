import type { ConfigEntry, ResolvedEntry, ResolvedGraph } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';
import { stripNamespace } from '../utils/path.js';

import { ensureProjectionAllowed, getNamespaceNameForKey } from './validatePromotion.js';

function toPublicKey(key: string): string {
  const namespace = getNamespaceNameForKey(key);
  return namespace === 'value' ? `public.${stripNamespace(key)}` : `public.${key}`;
}

function toPromotedConfigEntry(entry: ConfigEntry, key: string, promotedFrom: string): ConfigEntry {
  return {
    ...entry,
    key,
    namespace: 'public',
    sourceId: 'public-promote',
    pluginId: 'core',
    metadata: {
      ...(entry.metadata ?? {}),
      promotedFrom,
    },
  };
}

function toPromotedResolvedEntry(entry: ResolvedEntry): ResolvedEntry {
  const key = toPublicKey(entry.key);

  return {
    key,
    value: entry.value,
    namespace: 'public',
    winner: toPromotedConfigEntry(entry.winner, key, entry.key),
    overridden: entry.overridden.map((override) => toPromotedConfigEntry(override, key, entry.key)),
  };
}

export function promoteToPublic(
  graph: ResolvedGraph,
  manifest: NormalizedManifest,
): ResolvedGraph {
  const entries = new Map(graph.entries);

  for (const key of manifest.public.promote) {
    ensureProjectionAllowed(manifest, key, 'public');
    const resolved = graph.entries.get(key);

    if (!resolved) {
      continue;
    }

    entries.set(toPublicKey(key), toPromotedResolvedEntry(resolved));
  }

  return {
    ...graph,
    entries,
  };
}
