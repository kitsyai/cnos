import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadManifest, parseYaml, stringifyYaml } from '@kitsy/cnos/internal';

async function resolveProfilesRoot(root = process.cwd()): Promise<string> {
  try {
    const loadedManifest = await loadManifest({ root });
    return path.join(loadedManifest.manifestRoot, 'profiles');
  } catch {
    const loadedManifest = await loadManifest({ cwd: root });
    return path.join(loadedManifest.manifestRoot, 'profiles');
  }
}

function createPrivateProfileActivation(profile: string): {
  values: string[];
  secrets: string[];
} {
  return {
    values: [`.private/profiles/${profile}/values`, `.private/values/${profile}`],
    secrets: [`.private/profiles/${profile}/secrets`, `.private/secrets/${profile}`],
  };
}

export async function createProfileDefinition(
  root = process.cwd(),
  profile: string,
  inherit?: string,
  options: { noInherit?: boolean; privateProfile?: boolean } = {},
): Promise<{ filePath: string; profile: string; inherit?: string; noInherit?: boolean }> {
  const filePath = path.join(await resolveProfilesRoot(root), `${profile}.yml`);
  await mkdir(path.dirname(filePath), { recursive: true });
  const privateProfile = options.privateProfile === true;
  const document = options.noInherit
    ? {
        ...(privateProfile ? { private: true } : {}),
        name: profile,
        activate: {
          values: privateProfile
            ? createPrivateProfileActivation(profile).values
            : [`profiles/${profile}/values`, `values/${profile}`],
          secrets: privateProfile
            ? createPrivateProfileActivation(profile).secrets
            : [`profiles/${profile}/secrets`, `secrets/${profile}`],
          envFiles: [`.env.${profile}`],
        },
      }
    : inherit && inherit !== 'base'
      ? {
          ...(privateProfile ? { private: true } : {}),
          name: profile,
          extends: [inherit],
          ...(privateProfile ? { activate: createPrivateProfileActivation(profile) } : {}),
        }
      : {
          ...(privateProfile ? { private: true } : {}),
          name: profile,
        };

  await writeFile(filePath, stringifyYaml(document), 'utf8');

  return {
    filePath,
    profile,
    ...(inherit ? { inherit } : {}),
    ...(options.noInherit ? { noInherit: true } : {}),
  };
}

export async function listProfiles(root = process.cwd()): Promise<string[]> {
  const profilesRoot = await resolveProfilesRoot(root);

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
  const filePath = path.join(await resolveProfilesRoot(root), `${profile}.yml`);

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

  const filePath = path.join(await resolveProfilesRoot(root), `${profile}.yml`);

  try {
    return parseYaml<Record<string, unknown>>(await readFile(filePath, 'utf8')) ?? undefined;
  } catch {
    return undefined;
  }
}
