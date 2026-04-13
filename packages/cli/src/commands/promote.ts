import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import {
  ensureProjectionAllowed,
  loadManifest,
  stringifyYaml,
} from '@kitsy/cnos/internal';

import { consumeOption } from '../cli/commandOptions.js';
import { displayPath } from '../format/displayPath.js';
import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { assertWritableConfigRoot } from '../services/rootAccess.js';

type PromoteTarget = 'public' | 'env';

function normalizeTarget(value: string | undefined): PromoteTarget {
  if (value === 'public' || value === 'env') {
    return value;
  }

  throw new Error('promote requires --to public|env');
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

export async function runPromote(
  args: string[] = [],
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const root = path.resolve(options.root ?? process.cwd());
  const cliArgs = [...(options.cliArgs ?? [])];
  const target = normalizeTarget(consumeOption(cliArgs, '--to'));
  const alias = consumeOption(cliArgs, '--as');
  const keys = args.filter(Boolean);

  if (keys.length === 0) {
    throw new Error('promote requires at least one logical key');
  }

  if (target === 'env') {
    if (keys.length !== 1) {
      throw new Error('promote --to env requires exactly one logical key');
    }

    if (!alias) {
      throw new Error('promote --to env requires --as <ENV_VAR>');
    }
  }

  const loadedManifest = await loadManifest({
    ...(options.root ? { root: options.root } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
    ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
    ...(typeof options.cacheTtlSeconds === 'number' ? { cacheTtlSeconds: options.cacheTtlSeconds } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
  });
  await assertWritableConfigRoot(`promote ${keys.join(', ')}`, options);

  for (const key of keys) {
    ensureProjectionAllowed(loadedManifest.manifest, key, target);
  }

  const rawManifest = {
    ...loadedManifest.rawManifest,
  };

  if (target === 'public') {
    rawManifest.public = {
      ...(rawManifest.public ?? {}),
      promote: Array.from(new Set([...(rawManifest.public?.promote ?? []), ...keys])).sort((left, right) =>
        left.localeCompare(right),
      ),
    };
  } else {
    rawManifest.envMapping = {
      ...(rawManifest.envMapping ?? {}),
      explicit: sortRecord({
        ...(rawManifest.envMapping?.explicit ?? {}),
        [alias as string]: keys[0] as string,
      }),
    };
  }

  await writeFile(loadedManifest.manifestPath, stringifyYaml(rawManifest), 'utf8');

  if (options.json) {
    return printJson({
      target,
      keys,
      ...(target === 'env' ? { envVar: alias } : {}),
      manifestPath: loadedManifest.manifestPath,
    });
  }

  return target === 'public'
    ? `promoted ${keys.join(', ')} to public in ${displayPath(loadedManifest.manifestPath, root)}`
    : `promoted ${keys[0]} to env as ${alias} in ${displayPath(loadedManifest.manifestPath, root)}`;
}
