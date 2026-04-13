import type { NormalizedManifest } from '../types/manifest.js';
import type { ResolvedGraph, ToEnvOptions } from '../types/core.js';
import { isSecretReference } from '../utils/secretStore.js';
import { getNamespaceDefinition } from '../promotions/validatePromotion.js';

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
  helpers: {
    read?: (key: string) => unknown;
    isRuntimeDependent?: (key: string) => boolean;
  } = {},
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

    const namespaceDefinition = getNamespaceDefinition(manifest, entry.namespace);

    if (namespaceDefinition.kind !== 'data' || !namespaceDefinition.shareable || namespaceDefinition.sensitive) {
      continue;
    }

    if (entry.namespace === 'secret' && !includeSecrets) {
      continue;
    }

    if (isSecretReference(entry.value)) {
      continue;
    }

    const value = helpers.read ? helpers.read(logicalKey) : entry.value;

    if (value === undefined) {
      continue;
    }

    output[envVar] = normalizeEnvValue(value);
  }

  return output;
}
