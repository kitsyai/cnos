import { writeFile } from 'node:fs/promises';

import type { ConfigSpecRule } from '@kitsy/cnos-core';
import { loadManifest, stringifyYaml } from '@kitsy/cnos/internal';

import type { RuntimeServiceOptions } from '../runtime.js';

export interface SpecEntry {
  key: string;
  rule: ConfigSpecRule;
}

interface LoadedSpecManifest {
  manifestPath: string;
  rawManifest: Record<string, unknown>;
  schema: Record<string, ConfigSpecRule>;
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function sortSchema(schema: Record<string, ConfigSpecRule>): Record<string, ConfigSpecRule> {
  return Object.fromEntries(Object.entries(schema).sort(([left], [right]) => left.localeCompare(right)));
}

async function loadSpecManifest(options: RuntimeServiceOptions = {}): Promise<LoadedSpecManifest> {
  const loadedManifest = await loadManifest({
    ...(options.root ? { root: options.root } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
    ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
    ...(typeof options.cacheTtlSeconds === 'number' ? { cacheTtlSeconds: options.cacheTtlSeconds } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
  });
  return {
    manifestPath: loadedManifest.manifestPath,
    rawManifest: loadedManifest.rawManifest as Record<string, unknown>,
    schema: loadedManifest.manifest.schema,
  };
}

export async function listSpecEntries(
  options: RuntimeServiceOptions & { prefix?: string } = {},
): Promise<{ manifestPath: string; entries: SpecEntry[] }> {
  const loaded = await loadSpecManifest(options);
  const prefix = options.prefix?.trim();
  const entries = Object.entries(loaded.schema)
    .filter(([key]) => (prefix ? key.startsWith(prefix) : true))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rule]) => ({
      key,
      rule,
    }));

  return {
    manifestPath: loaded.manifestPath,
    entries,
  };
}

export async function showSpecEntry(
  logicalKey: string,
  options: RuntimeServiceOptions = {},
): Promise<{ manifestPath: string; key: string; rule?: ConfigSpecRule }> {
  const loaded = await loadSpecManifest(options);
  const key = logicalKey.trim();

  return {
    manifestPath: loaded.manifestPath,
    key,
    ...(loaded.schema[key]
      ? {
          rule: loaded.schema[key],
        }
      : {}),
  };
}

export async function setSpecEntry(
  logicalKey: string,
  options: RuntimeServiceOptions & {
    set?: Partial<ConfigSpecRule>;
    clear?: Array<keyof ConfigSpecRule>;
  } = {},
): Promise<{ manifestPath: string; key: string; action: 'created' | 'updated'; rule: ConfigSpecRule }> {
  const loaded = await loadSpecManifest(options);
  const key = logicalKey.trim();
  const hasSetFields = Object.keys(options.set ?? {}).length > 0;

  if (!loaded.schema[key] && !hasSetFields) {
    throw new Error(`Cannot clear fields for undeclared spec key ${key}.`);
  }

  const current = loaded.schema[key] ?? {};
  const next: ConfigSpecRule = {
    ...current,
    ...(options.set ?? {}),
  };

  for (const field of options.clear ?? []) {
    if (hasOwn(next as object, field)) {
      delete (next as Record<string, unknown>)[field];
    }
  }

  if (Object.keys(next).length === 0) {
    throw new Error(`Spec entry ${key} cannot be empty. Set at least one field or delete the entry.`);
  }

  const nextSchema = sortSchema({
    ...loaded.schema,
    [key]: next,
  });
  const nextRawManifest = {
    ...loaded.rawManifest,
    schema: nextSchema,
  };

  await writeFile(loaded.manifestPath, stringifyYaml(nextRawManifest), 'utf8');

  return {
    manifestPath: loaded.manifestPath,
    key,
    action: loaded.schema[key] ? 'updated' : 'created',
    rule: next,
  };
}

export async function deleteSpecEntry(
  logicalKey: string,
  options: RuntimeServiceOptions = {},
): Promise<{ manifestPath: string; key: string; deleted: boolean }> {
  const loaded = await loadSpecManifest(options);
  const key = logicalKey.trim();

  if (!loaded.schema[key]) {
    return {
      manifestPath: loaded.manifestPath,
      key,
      deleted: false,
    };
  }

  const nextSchema = { ...loaded.schema };
  delete nextSchema[key];
  const sorted = sortSchema(nextSchema);
  const nextRawManifest = {
    ...loaded.rawManifest,
    ...(Object.keys(sorted).length > 0 ? { schema: sorted } : {}),
  };

  if (Object.keys(sorted).length === 0) {
    delete (nextRawManifest as { schema?: unknown }).schema;
  }

  await writeFile(loaded.manifestPath, stringifyYaml(nextRawManifest), 'utf8');

  return {
    manifestPath: loaded.manifestPath,
    key,
    deleted: true,
  };
}
