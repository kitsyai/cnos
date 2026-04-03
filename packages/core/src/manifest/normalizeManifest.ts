import type { CnosManifest } from '../types/manifest.js';

export function normalizeManifest(manifest: CnosManifest): CnosManifest {
  return {
    profiles: [],
    entries: [],
    ...manifest,
  };
}
