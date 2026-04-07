import type { NormalizedManifest } from '../types/manifest.js';
import type { ValidationIssue } from '../types/plugin.js';
import { validateProjectionIssue } from '../promotions/validatePromotion.js';

export function validatePublicSafety(manifest: NormalizedManifest): ValidationIssue[] {
  return manifest.public.promote
    .map((key) => validateProjectionIssue(manifest, key, 'public'))
    .filter((issue): issue is ValidationIssue => Boolean(issue));
}
