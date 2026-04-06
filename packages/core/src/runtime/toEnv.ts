import type { NormalizedManifest } from '../types/manifest.js';
import type { ResolvedGraph, ToEnvOptions } from '../types/core.js';
import { isSecretReference } from '../utils/secretStore.js';

function normalizeEnvValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  return JSON.stringify(value);
}

export function toEnv(
  graph: ResolvedGraph,
  manifest: NormalizedManifest,
  options: ToEnvOptions = {},
): Record<string, string> {
  const includeSecrets = options.includeSecrets ?? true;
  const output: Record<string, string> = {};
  const mappedEntries = Object.entries(manifest.envMapping.explicit).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  for (const [envVar, logicalKey] of mappedEntries) {
    const entry = graph.entries.get(logicalKey);

    if (!entry) {
      continue;
    }

    if (entry.namespace === 'secret' && !includeSecrets) {
      continue;
    }

    if (isSecretReference(entry.value)) {
      continue;
    }

    output[envVar] = normalizeEnvValue(entry.value);
  }

  return output;
}
