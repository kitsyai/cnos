import type { CnosManifest } from '../types/manifest.js';
import type { CnosProfileSelection } from '../types/profile.js';

export function resolveActiveProfile(
  manifest: CnosManifest,
  selection: CnosProfileSelection = {},
): string | undefined {
  if (selection.activeProfile) {
    return selection.activeProfile;
  }

  return manifest.profiles?.[0]?.name;
}
