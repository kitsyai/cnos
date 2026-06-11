import { readFile } from 'node:fs/promises';

import { CnosAuthenticationError } from '../errors.js';
import type { VaultDefinition } from '../types/manifest.js';
import { readKeychain } from '../keychain/index.js';
import { promptHidden } from './prompt.js';
import {
  getVaultPassphraseEnvVar,
  getVaultSessionKeyEnvVar,
  resolveSecretPassphrase,
  resolveVaultSessionKey,
} from '../utils/secretStore.js';
import { expandHomePath } from '../utils/path.js';
import type { VaultAuthConfig } from './types.js';

function toAuthError(vaultId: string, sources: string[]): CnosAuthenticationError {
  return new CnosAuthenticationError(
    `Cannot authenticate to vault "${vaultId}". Tried: ${sources.join(', ')}. Set ${getVaultPassphraseEnvVar(vaultId)} or run cnos vault auth ${vaultId}.`,
  );
}

async function resolveTokenFromSource(
  source: string,
  processEnv: Record<string, string | undefined>,
): Promise<string | undefined> {
  if (source.startsWith('env:')) {
    return processEnv[source.slice(4)] || undefined;
  }

  if (source.startsWith('file:')) {
    try {
      const value = await readFile(expandHomePath(source.slice('file:'.length)), 'utf8');
      return value.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  if (source.startsWith('keychain:')) {
    return readKeychain(source.slice('keychain:'.length));
  }

  return undefined;
}

export async function resolveVaultAuth(
  vaultId: string,
  definition: VaultDefinition,
  processEnv: Record<string, string | undefined> = process.env,
): Promise<VaultAuthConfig> {
  const sessionKey = await resolveVaultSessionKey(vaultId, processEnv);

  if (sessionKey) {
    return {
      derivedKey: sessionKey,
      method: 'keychain',
      ...(definition.auth?.config ? { config: definition.auth.config } : {}),
    };
  }

  if (definition.provider === 'github-secrets' || definition.provider === 'environment') {
    return {
      method: definition.auth?.method ?? 'environment',
      ...(definition.auth?.config ? { config: definition.auth.config } : {}),
    };
  }

  if (definition.auth?.method === 'iam') {
    return {
      method: 'iam',
      ...(definition.auth?.config ? { config: definition.auth.config } : {}),
    };
  }

  if (definition.auth?.method === 'environment') {
    return {
      method: 'environment',
      ...(definition.auth?.config ? { config: definition.auth.config } : {}),
    };
  }

  const tokenSources = definition.auth?.token?.from ?? [];

  for (const source of tokenSources) {
    const token = await resolveTokenFromSource(source, processEnv);

    if (token) {
      return {
        token,
        method: 'token',
        ...(definition.auth?.config ? { config: definition.auth.config } : {}),
      };
    }
  }

  if (definition.auth?.method === 'token') {
    throw toAuthError(vaultId, [getVaultSessionKeyEnvVar(vaultId), ...tokenSources]);
  }

  const sources = definition.auth?.passphrase?.from ?? [getVaultPassphraseEnvVar(vaultId)];

  for (const source of sources) {
    if (source.startsWith('env:')) {
      const value = processEnv[source.slice(4)];

      if (value) {
        return {
          passphrase: value,
          method: 'passphrase',
          ...(definition.auth?.config ? { config: definition.auth.config } : {}),
        };
      }
    }

    if (source.startsWith('keychain:')) {
      const value = await readKeychain(source.slice('keychain:'.length));

      if (value) {
        return {
          derivedKey: Buffer.from(value, 'hex'),
          method: 'keychain',
          ...(definition.auth?.config ? { config: definition.auth.config } : {}),
        };
      }
    }

    if (source === 'prompt') {
      const value = await promptHidden(`Enter passphrase for vault "${vaultId}": `);

      if (value) {
        return {
          passphrase: value,
          method: 'passphrase',
          ...(definition.auth?.config ? { config: definition.auth.config } : {}),
        };
      }
    }
  }

  const fallback = resolveSecretPassphrase(vaultId, processEnv);

  if (fallback) {
    return {
      passphrase: fallback,
      method: 'passphrase',
      ...(definition.auth?.config ? { config: definition.auth.config } : {}),
    };
  }

  throw toAuthError(vaultId, [getVaultSessionKeyEnvVar(vaultId), ...sources]);
}
