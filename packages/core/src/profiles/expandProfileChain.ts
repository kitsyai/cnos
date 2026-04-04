import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { CnosManifestError } from '../errors.js';
import type {
  ExpandedProfileChain,
  NormalizedProfileDefinition,
  ProfileActivation,
  ProfileDefinitionFile,
} from '../types/profile.js';
import type { WorkspaceContext } from '../types/workspace.js';
import { toPortablePath } from '../utils/path.js';
import { parseYaml } from '../utils/yaml.js';

export interface ExpandProfileChainOptions {
  manifestRoot?: string;
  workspace?: WorkspaceContext;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeProfileDefinition(
  profileName: string,
  rawDefinition: ProfileDefinitionFile | undefined,
  filePath?: string,
): NormalizedProfileDefinition {
  const normalizeActivationLayer = (
    entry: string,
    namespace: 'values' | 'secrets',
  ): string => {
    const normalized = entry.trim();

    if (!normalized) {
      return normalized;
    }

    if (normalized.includes('/') || normalized.includes('\\') || normalized.startsWith('.')) {
      return normalized.replace(/\\/g, '/');
    }

    return `${namespace}/${normalized}`;
  };

  return {
    name: rawDefinition?.name?.trim() || profileName,
    extends: Array.isArray(rawDefinition?.extends)
      ? rawDefinition.extends.map((entry) => entry.trim()).filter(Boolean)
      : rawDefinition?.extends
        ? [rawDefinition.extends.trim()].filter(Boolean)
        : [],
    activate: {
      values:
        rawDefinition?.activate?.values
          ?.map((entry) => normalizeActivationLayer(entry, 'values'))
          .filter(Boolean) ?? [],
      secrets:
        rawDefinition?.activate?.secrets
          ?.map((entry) => normalizeActivationLayer(entry, 'secrets'))
          .filter(Boolean) ?? [],
      envFiles: rawDefinition?.activate?.envFiles?.map((entry) => entry.trim()).filter(Boolean) ?? [],
    },
    ...(filePath ? { filePath } : {}),
  };
}

async function loadProfileDefinition(
  profileName: string,
  options: ExpandProfileChainOptions,
): Promise<NormalizedProfileDefinition> {
  const workspaceRoots = options.workspace?.workspaceRoots ?? [];

  if (workspaceRoots.length === 0) {
    return normalizeProfileDefinition(profileName, undefined);
  }

  for (const workspaceRoot of [...workspaceRoots].reverse()) {
    const profilePath = path.join(workspaceRoot.path, 'profiles', `${profileName}.yml`);

    if (!(await fileExists(profilePath))) {
      continue;
    }

    const document = await readFile(profilePath, 'utf8');
    const parsed = parseYaml<unknown>(document);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CnosManifestError('Profile definition must be a YAML object', profilePath);
    }

    const definition = normalizeProfileDefinition(
      profileName,
      parsed as ProfileDefinitionFile,
      options.manifestRoot ? toPortablePath(path.relative(path.dirname(options.manifestRoot), profilePath)) : toPortablePath(profilePath),
    );

    if (definition.name !== profileName) {
      throw new CnosManifestError(
        `Profile file name mismatch: expected "${profileName}" but found "${definition.name}"`,
        profilePath,
      );
    }

    return definition;
  }

  return normalizeProfileDefinition(profileName, undefined);
}

function pushUnique(target: string[], values: string[]): void {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}

function buildFallbackActivation(activeProfile: string, orderedProfiles: string[]): ProfileActivation {
  const overlayProfiles = orderedProfiles.filter((profile) => profile !== 'base');

  return {
    values: [
      'values',
      ...(activeProfile !== 'base' ? ['values/base'] : []),
      ...overlayProfiles.flatMap((profile) => [`profiles/${profile}/values`, `values/${profile}`]),
    ],
    secrets: [
      'secrets',
      ...overlayProfiles.flatMap((profile) => [`profiles/${profile}/secrets`, `secrets/${profile}`]),
    ],
    envFiles:
      activeProfile === 'base' ? ['.env'] : ['.env', `.env.${activeProfile}`],
  };
}

export async function expandProfileChain(
  activeProfile: string,
  options: ExpandProfileChainOptions = {},
): Promise<ExpandedProfileChain> {
  const visiting = new Set<string>();
  const resolved = new Set<string>();
  const orderedProfiles: string[] = [];
  const definitions = new Map<string, NormalizedProfileDefinition>();

  const visit = async (profileName: string): Promise<void> => {
    if (resolved.has(profileName)) {
      return;
    }

    if (visiting.has(profileName)) {
      throw new CnosManifestError(`Detected profile inheritance cycle involving "${profileName}"`);
    }

    visiting.add(profileName);
    const definition = await loadProfileDefinition(profileName, options);
    definitions.set(profileName, definition);

    for (const parent of definition.extends) {
      await visit(parent);
    }

    visiting.delete(profileName);
    resolved.add(profileName);
    orderedProfiles.push(profileName);
  };

  await visit(activeProfile);

  const activation: ProfileActivation = {
    values: [],
    secrets: [],
    envFiles: [],
  };

  for (const profileName of orderedProfiles) {
    const definition = definitions.get(profileName);

    if (!definition) {
      continue;
    }

    pushUnique(activation.values, definition.activate.values);
    pushUnique(activation.secrets, definition.activate.secrets);
    pushUnique(activation.envFiles, definition.activate.envFiles);
  }

  const fallback = buildFallbackActivation(activeProfile, orderedProfiles);

  if (activation.values.length === 0) {
    activation.values = fallback.values;
  }

  if (activation.secrets.length === 0) {
    activation.secrets = fallback.secrets;
  }

  if (activation.envFiles.length === 0) {
    activation.envFiles = fallback.envFiles;
  }

  return {
    activeProfile,
    profiles: orderedProfiles,
    activation,
  };
}
