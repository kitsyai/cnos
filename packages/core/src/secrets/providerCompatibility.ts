import { CnosManifestError } from '../errors.js';
import type { SecretReference } from './types.js';
import type { NormalizedManifest } from '../types/manifest.js';

export function assertSecretRefVaultProviderCompatible(
  manifest: NormalizedManifest,
  ref: SecretReference,
  logicalKey = 'secret ref',
): void {
  if (!ref.vault || !ref.provider) {
    return;
  }

  const definition = manifest.vaults[ref.vault];

  if (!definition || definition.provider === ref.provider) {
    return;
  }

  throw new CnosManifestError(
    `Secret ref "${logicalKey}" declares provider "${ref.provider}" but vault "${ref.vault}" uses provider "${definition.provider}". Remove the ref provider or use a matching vault.`,
  );
}
