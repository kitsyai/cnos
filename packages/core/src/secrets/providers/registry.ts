import { CnosManifestError } from '../../errors.js';
import type { VaultDefinition } from '../../types/manifest.js';
import type { SecretVaultProvider, SecretVaultProviderFactory } from '../types.js';
import { EnvironmentSecretsVaultProvider } from './environment.js';
import { GithubSecretsVaultProvider } from './github.js';
import { LocalSecretVaultProvider } from './local.js';

export function createSecretVaultProvider(
  vaultId: string,
  definition: VaultDefinition,
  processEnv?: Record<string, string | undefined>,
  factories: SecretVaultProviderFactory[] = [],
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

  const factory = factories.find((candidate) => candidate.provider === definition.provider);

  if (factory) {
    return factory.create(vaultId, definition, processEnv);
  }

  throw new CnosManifestError(`Unsupported vault provider: ${definition.provider}`);
}
