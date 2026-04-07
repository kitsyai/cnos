import { CnosManifestError } from '../errors.js';
import type { NormalizedManifest } from '../types/manifest.js';
import type { ResolvedGraph, ToPublicEnvOptions } from '../types/core.js';
import { stripNamespace } from '../utils/path.js';

function fallbackPublicEnvVar(valuePath: string): string {
  return valuePath
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

function resolvePublicPrefix(
  manifest: NormalizedManifest,
  options: ToPublicEnvOptions,
): string {
  if (options.prefix) {
    return options.prefix;
  }

  if (!options.framework) {
    return '';
  }

  const configuredPrefix = manifest.public.frameworks[options.framework];

  if (!configuredPrefix) {
    throw new CnosManifestError(`Unknown public framework prefix: ${options.framework}`);
  }

  return configuredPrefix;
}
export function toPublicEnv(
  graph: ResolvedGraph,
  manifest: NormalizedManifest,
  options: ToPublicEnvOptions = {},
): Record<string, string> {
  const prefix = resolvePublicPrefix(manifest, options);
  const output: Record<string, string> = {};
  const promotions = Array.from(graph.entries.values())
    .filter((entry) => entry.namespace === 'public')
    .sort((left, right) => left.key.localeCompare(right.key));

  for (const resolved of promotions) {
    const baseEnvVar = fallbackPublicEnvVar(stripNamespace(resolved.key));
    const envVar = prefix && !baseEnvVar.startsWith(prefix) ? `${prefix}${baseEnvVar}` : baseEnvVar;
    output[envVar] = normalizeEnvValue(resolved.value);
  }

  return output;
}
