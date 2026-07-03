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
  usePrivate?: boolean;
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
    private: Boolean(rawDefinition?.private),
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

function isPrivateActivationLayer(entry: string): boolean {
  const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized === '.private' || normalized.startsWith('.private/');
}

function filterVisibleActivationLayers(entries: string[], usePrivate: boolean): string[] {
  if (usePrivate) {
    return entries;
  }

  return entries.filter((entry) => !isPrivateActivationLayer(entry));
}

function buildFallbackActivation(
  activeProfile: string,
  orderedProfiles: string[],
  profileByName: Map<string, NormalizedProfileDefinition>,
  usePrivate: boolean,
): ProfileActivation {
  const overlayProfiles = orderedProfiles.filter((profile) => profile !== 'base');
  const includeActiveProfileEnv = activeProfile !== 'base' && !((profileByName.get(activeProfile)?.private ?? false) && !usePrivate);

  const buildNamespaceLayers = (
    profile: string,
    definition: NormalizedProfileDefinition,
    namespace: 'values' | 'secrets',
  ): string[] => {
    const activateLayers = filterVisibleActivationLayers(definition.activate[namespace], usePrivate);

    if (activateLayers.length > 0) {
      return activateLayers;
    }

    if (definition.private) {
      if (!usePrivate) {
        return [];
      }

      return [
        `.private/profiles/${profile}/${namespace}`,
        `.private/${namespace}/${profile}`,
      ];
    }

    if (!usePrivate) {
      return [`profiles/${profile}/${namespace}`, `${namespace}/${profile}`];
    }

    return [
      `profiles/${profile}/${namespace}`,
      `${namespace}/${profile}`,
      `.private/profiles/${profile}/${namespace}`,
      `.private/${namespace}/${profile}`,
    ];
  };

  const valueLayers = overlayProfiles.flatMap((profile) => {
    const definition = profileByName.get(profile);
    return definition ? buildNamespaceLayers(profile, definition, 'values') : [];
  });
  const secretLayers = overlayProfiles.flatMap((profile) => {
    const definition = profileByName.get(profile);
    return definition ? buildNamespaceLayers(profile, definition, 'secrets') : [];
  });
  const baseValueLayers = [
    'values',
    ...(activeProfile !== 'base' ? ['values/base'] : []),
    ...(usePrivate ? ['.private/values'] : []),
  ];
  const baseSecretLayers = ['secrets', ...(usePrivate ? ['.private/secrets'] : [])];

  return {
    values: [...baseValueLayers, ...valueLayers],
    secrets: [...baseSecretLayers, ...secretLayers],
    envFiles:
      activeProfile === 'base'
        ? ['.env']
        : ['.env', ...(includeActiveProfileEnv ? [`.env.${activeProfile}`] : [])],
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

    pushUnique(activation.values, filterVisibleActivationLayers(definition.activate.values, options.usePrivate ?? false));
    pushUnique(activation.secrets, filterVisibleActivationLayers(definition.activate.secrets, options.usePrivate ?? false));
    pushUnique(activation.envFiles, filterVisibleActivationLayers(definition.activate.envFiles, options.usePrivate ?? false));
  }

  const fallback = buildFallbackActivation(activeProfile, orderedProfiles, definitions, options.usePrivate ?? false);

  if (activation.envFiles.length === 0) {
    activation.envFiles = [...fallback.envFiles];
  }

  if (activation.values.length === 0) {
    activation.values = [...fallback.values];
  }
  if (activation.secrets.length === 0) {
    activation.secrets = [...fallback.secrets];
  }

  return {
    activeProfile,
    profiles: orderedProfiles,
    activation,
  };
}
