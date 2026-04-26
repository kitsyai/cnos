import { CnosManifestError } from '../../errors.js';
import type { VaultDefinition } from '../../types/manifest.js';
import type { SecretVaultProvider } from '../types.js';
import { EnvironmentSecretsVaultProvider } from './environment.js';
import { GithubSecretsVaultProvider } from './github.js';
import { LocalSecretVaultProvider } from './local.js';

export function createSecretVaultProvider(
  vaultId: string,
  definition: VaultDefinition,
  processEnv?: Record<string, string | undefined>,
): SecretVaultProvider {
  if (definition.provider === 'local') {
    return new LocalSecretVaultProvider(vaultId, definition, processEnv);
  }

  if (definition.provider === 'environment') {
    return new EnvironmentSecretsVaultProvider(vaultId, definition, processEnv);
  }

  if (definition.provider === 'github-secrets') {
    return new GithubSecretsVaultProvider(vaultId, definition, processEnv);
  }

  throw new CnosManifestError(`Unsupported vault provider: ${definition.provider}`);
}
