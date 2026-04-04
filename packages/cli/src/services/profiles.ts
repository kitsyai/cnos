import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseYaml, stringifyYaml } from '@kitsy/cnos/internal';

export async function createProfileDefinition(
  root = process.cwd(),
  profile: string,
  inherit?: string,
): Promise<{ filePath: string; profile: string; inherit?: string }> {
  const filePath = path.join(path.resolve(root), '.cnos', 'profiles', `${profile}.yml`);
  await mkdir(path.dirname(filePath), { recursive: true });
  const document =
    inherit && inherit !== 'base'
      ? {
          name: profile,
          extends: [inherit],
        }
      : {
          name: profile,
        };

  await writeFile(filePath, stringifyYaml(document), 'utf8');

  return {
    filePath,
    profile,
    ...(inherit ? { inherit } : {}),
  };
}

export async function listProfiles(root = process.cwd()): Promise<string[]> {
  const profilesRoot = path.join(path.resolve(root), '.cnos', 'profiles');

  try {
    const entries = await readdir(profilesRoot, { withFileTypes: true });
    const discovered = new Set<string>(['base']);

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.yml')) {
        discovered.add(entry.name.replace(/\.yml$/, ''));
      }
    }

    return [...discovered].sort((left, right) => left.localeCompare(right));
  } catch {
    return ['base'];
  }
}

export async function deleteProfileDefinition(
  root = process.cwd(),
  profile: string,
): Promise<{ filePath: string; deleted: boolean }> {
  const filePath = path.join(path.resolve(root), '.cnos', 'profiles', `${profile}.yml`);

  try {
    await rm(filePath);
    return {
      filePath,
      deleted: true,
    };
  } catch {
    return {
      filePath,
      deleted: false,
    };
  }
}

export async function readProfileDefinition(
  root = process.cwd(),
  profile = 'base',
): Promise<Record<string, unknown> | undefined> {
  if (profile === 'base') {
    return {
      name: 'base',
    };
  }

  const filePath = path.join(path.resolve(root), '.cnos', 'profiles', `${profile}.yml`);

  try {
    return parseYaml<Record<string, unknown>>(await readFile(filePath, 'utf8')) ?? undefined;
  } catch {
    return undefined;
  }
}
