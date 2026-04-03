import type { NormalizedManifest } from '../types/manifest.js';
import type { ResolvedGraph, ToEnvOptions } from '../types/core.js';
import { logicalKeyToEnvVar } from '../utils/envNaming.js';

function fallbackLogicalKeyToEnvVar(key: string): string {
  if (key.startsWith('value.')) {
    return key
      .slice('value.'.length)
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
  }

  if (key.startsWith('secret.')) {
    const normalized = key
      .slice('secret.'.length)
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
    return `SECRET_${normalized}`;
  }

  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

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
  const resolvedEntries = Array.from(graph.entries.values()).sort((left, right) =>
    left.key.localeCompare(right.key),
  );

  for (const entry of resolvedEntries) {
    if (entry.namespace === 'meta') {
      continue;
    }

    if (!includeSecrets && entry.namespace === 'secret') {
      continue;
    }

    const envVar =
      logicalKeyToEnvVar(entry.key, manifest.envMapping) ?? fallbackLogicalKeyToEnvVar(entry.key);
    output[envVar] = normalizeEnvValue(entry.value);
  }

  return output;
}
