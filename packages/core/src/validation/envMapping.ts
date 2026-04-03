import type { ResolvedGraph } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';
import type { ValidationIssue } from '../types/plugin.js';
import { logicalKeyToEnvVar } from '../utils/envNaming.js';

function fallbackLogicalKeyToEnvVar(key: string): string {
  return key
    .replace(/^(value|secret)\./, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

export function validateEnvMappingCollisions(
  manifest: NormalizedManifest,
  graph?: ResolvedGraph,
): ValidationIssue[] {
  const candidates = new Set<string>([
    ...Object.values(manifest.envMapping.explicit),
    ...manifest.public.promote,
    ...Object.keys(manifest.schema),
    ...(graph ? Array.from(graph.entries.keys()) : []),
  ]);
  const collisions = new Map<string, string[]>();

  for (const key of candidates) {
    if (key.startsWith('meta.')) {
      continue;
    }

    const envVar =
      logicalKeyToEnvVar(key, manifest.envMapping) ??
      (key.startsWith('value.') || key.startsWith('secret.') ? fallbackLogicalKeyToEnvVar(key) : undefined);

    if (!envVar) {
      continue;
    }

    const keys = collisions.get(envVar) ?? [];
    keys.push(key);
    collisions.set(envVar, keys);
  }

  return Array.from(collisions.entries())
    .filter(([, keys]) => new Set(keys).size > 1)
    .map(([envVar, keys]) => ({
      code: 'env-mapping.collision',
      message: `Multiple logical keys map to env var ${envVar}: ${Array.from(new Set(keys)).join(', ')}`,
    }));
}
