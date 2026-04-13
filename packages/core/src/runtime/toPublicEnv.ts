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

  const hasConfiguredPrefix = Object.prototype.hasOwnProperty.call(
    manifest.public.frameworks,
    options.framework,
  );

  if (!hasConfiguredPrefix) {
    throw new CnosManifestError(`Unknown public framework prefix: ${options.framework}`);
  }

  return manifest.public.frameworks[options.framework] ?? '';
}
export function toPublicEnv(
  graph: ResolvedGraph,
  manifest: NormalizedManifest,
  options: ToPublicEnvOptions = {},
  helpers: {
    read?: (key: string) => unknown;
    isRuntimeDependent?: (key: string) => boolean;
  } = {},
): Record<string, string> {
  const prefix = resolvePublicPrefix(manifest, options);
  const output: Record<string, string> = {};
  const promotions = Array.from(graph.entries.values())
    .filter((entry) => entry.namespace === 'public')
    .sort((left, right) => left.key.localeCompare(right.key));

  for (const resolved of promotions) {
    if (helpers.isRuntimeDependent?.(resolved.key)) {
      const value = helpers.read?.(resolved.key);

      if (value === undefined) {
        throw new CnosManifestError(`Cannot build public output for ${resolved.key} because it depends on runtime-only values.`);
      }
    }

    const baseEnvVar = fallbackPublicEnvVar(stripNamespace(resolved.key));
    const envVar = prefix && !baseEnvVar.startsWith(prefix) ? `${prefix}${baseEnvVar}` : baseEnvVar;
    const value = helpers.read ? helpers.read(resolved.key) : resolved.value;

    if (value === undefined) {
      continue;
    }

    output[envVar] = normalizeEnvValue(value);
  }

  return output;
}
