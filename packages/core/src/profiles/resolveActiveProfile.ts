import type { NormalizedManifest } from '../types/manifest.js';
import type { ResolvedProfile } from '../types/profile.js';

export interface ResolveActiveProfileOptions {
  profile?: string;
  workspaceFile?: {
    profile?: string;
  };
  processEnv?: Record<string, string | undefined>;
}

export function resolveActiveProfile(
  manifest: NormalizedManifest,
  options: ResolveActiveProfileOptions = {},
): ResolvedProfile {
  for (const source of manifest.profiles.resolveFrom) {
    if (source === 'cli.profile' && options.profile) {
      return {
        profile: options.profile,
        source: 'cli',
      };
    }

    if (source === 'env.CNOS_PROFILE') {
      if (options.workspaceFile?.profile) {
        return {
          profile: options.workspaceFile.profile,
          source: 'workspace-file',
        };
      }

      const envProfile = options.processEnv?.CNOS_PROFILE;

      if (envProfile) {
        return {
          profile: envProfile,
          source: 'env',
        };
      }
    }

    if (source === 'default') {
      return {
        profile: manifest.profiles.default,
        source: 'manifest-default',
      };
    }
  }

  return {
    profile: manifest.profiles.default,
    source: 'manifest-default',
  };
}
