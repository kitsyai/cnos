import type { NormalizedManifest } from '../types/manifest.js';
import type { ValidationIssue } from '../types/plugin.js';

export function validatePublicSafety(manifest: NormalizedManifest): ValidationIssue[] {
  return manifest.public.promote
    .filter((key) => !key.startsWith('value.'))
    .map((key) => ({
      code: 'public.invalid-promotion',
      key,
      message: `public.promote may only include value.* keys: ${key}`,
    }));
}
