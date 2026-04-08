import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  clearAllVaultSessionKeys,
  clearVaultSessionKey,
  createSecretVault,
  deriveVaultKey,
  listLocalSecrets,
  loadManifest,
  listSecretVaults,
  readVaultMetadata,
  resolveSecretStoreRoot,
  resolveVaultAuth,
  resolveVaultDefinition,
  stringifyYaml,
  writeKeychain,
  writeVaultSessionKey,
  type ResolvedVaultDefinition,
  type VaultDefinition,
} from '@kitsy/cnos/internal';

import type { RuntimeServiceOptions } from './runtime.js';

export interface VaultRecord extends ResolvedVaultDefinition {
  authMethod: string;
  localStore: boolean;
}

function buildVaultDefinition(vault: string, provider: string): VaultDefinition {
  return provider === 'local'
    ? {
        provider: 'local',
        auth: {
          passphrase: {
            from: defaultLocalAuthSources(vault),
          },
        },
      }
    : {
        provider,
        auth: {
          method: 'environment',
        },
      };
}

function sortVaults<T extends Record<string, unknown>>(vaults: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(vaults).sort(([left], [right]) => left.localeCompare(right)));
}

function defaultLocalAuthSources(vault: string): string[] {
  const token = vault.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return [`env:CNOS_SECRET_PASSPHRASE_${token}`, 'env:CNOS_SECRET_PASSPHRASE', `keychain:cnos/${vault}`, 'prompt'];
}

export async function createVaultDefinition(
  name: string,
  options: RuntimeServiceOptions & {
    provider?: string;
    noPassphrase?: boolean;
  } = {},
): Promise<VaultRecord & { manifestPath: string }> {
  const vault = name.trim() || 'default';
  const provider = options.provider?.trim() || 'local';

  if (provider === 'local' && (options.noPassphrase ?? false)) {
    throw new Error('Local vaults cannot be passwordless.');
  }

  const loadedManifest = await loadManifest(options.root ? { root: options.root } : {});
  const vaultDefinition = buildVaultDefinition(vault, provider);
  const rawManifest = {
    ...loadedManifest.rawManifest,
    vaults: {
      ...(loadedManifest.rawManifest.vaults ?? {}),
      [vault]: vaultDefinition,
    },
  };

  await writeFile(loadedManifest.manifestPath, stringifyYaml(rawManifest), 'utf8');
  const definition = resolveVaultDefinition({ [vault]: vaultDefinition }, vault);

  if (provider === 'local') {
    const auth = await resolveVaultAuth(vault, vaultDefinition, options.processEnv ?? process.env);

    if (!auth.passphrase) {
      throw new Error(`Vault "${vault}" requires passphrase-based authentication during creation.`);
    }

    const storeRoot = resolveSecretStoreRoot(options.processEnv);
    const existing = await readVaultMetadata(storeRoot, vault);

    if (!existing) {
      await createSecretVault(storeRoot, vault, auth.passphrase);
    }
  }

  return {
    ...definition,
    authMethod: definition.auth?.method ?? (provider === 'local' ? 'passphrase' : 'environment'),
    localStore: provider === 'local',
    manifestPath: loadedManifest.manifestPath,
  };
}

export async function listVaultDefinitions(options: RuntimeServiceOptions = {}): Promise<VaultRecord[]> {
  const loadedManifest = await loadManifest(options.root ? { root: options.root } : {});
  const localStoreVaults = await listSecretVaults(resolveSecretStoreRoot(options.processEnv));

  return Object.keys(loadedManifest.manifest.vaults)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const definition = resolveVaultDefinition(loadedManifest.manifest.vaults, name);
      return {
        ...definition,
        authMethod: definition.auth?.method ?? (definition.provider === 'local' ? 'passphrase' : 'environment'),
        localStore: localStoreVaults.includes(name),
      };
    });
}

export async function removeVaultDefinition(
  name: string,
  options: RuntimeServiceOptions = {},
): Promise<{ name: string; deleted: boolean; manifestPath: string; removedStore?: string }> {
  const vault = name.trim() || 'default';
  const loadedManifest = await loadManifest(options.root ? { root: options.root } : {});

  if (!loadedManifest.rawManifest.vaults?.[vault]) {
    return {
      name: vault,
      deleted: false,
      manifestPath: loadedManifest.manifestPath,
    };
  }

  const nextVaults = { ...(loadedManifest.rawManifest.vaults ?? {}) };
  delete nextVaults[vault];
  const rawManifest = {
    ...loadedManifest.rawManifest,
    ...(Object.keys(nextVaults).length > 0 ? { vaults: sortVaults(nextVaults) } : {}),
  };

  if (Object.keys(nextVaults).length === 0) {
    delete rawManifest.vaults;
  }

  await writeFile(loadedManifest.manifestPath, stringifyYaml(rawManifest), 'utf8');

  const vaultRoot = path.join(resolveSecretStoreRoot(options.processEnv), 'vaults', vault);
  let removedStore: string | undefined;

  try {
    await rm(vaultRoot, { recursive: true, force: true });
    removedStore = vaultRoot;
  } catch {
    removedStore = undefined;
  }

  await clearVaultSessionKey(vault, options.processEnv);

  return {
    name: vault,
    deleted: true,
    manifestPath: loadedManifest.manifestPath,
    ...(removedStore ? { removedStore } : {}),
  };
}

export async function ensureVaultDefinition(
  name: string,
  options: RuntimeServiceOptions = {},
): Promise<ResolvedVaultDefinition> {
  const loadedManifest = await loadManifest(options.root ? { root: options.root } : {});
  return resolveVaultDefinition(loadedManifest.manifest.vaults, name.trim() || 'default');
}

export async function listLocalStoreVaults(options: RuntimeServiceOptions = {}): Promise<string[]> {
  return listSecretVaults(resolveSecretStoreRoot(options.processEnv));
}

export async function authenticateVault(
  name: string,
  options: RuntimeServiceOptions & { storeKeychain?: boolean } = {},
): Promise<{ name: string; method: string; storedInKeychain: boolean; sessionPath: string }> {
  const vault = name.trim() || 'default';
  const loadedManifest = await loadManifest(options.root ? { root: options.root } : {});
  const definition = loadedManifest.manifest.vaults[vault];

  if (!definition) {
    throw new Error(`Unknown vault "${vault}"`);
  }

  const auth = await resolveVaultAuth(vault, definition, options.processEnv ?? process.env);
  const storeRoot = resolveSecretStoreRoot(options.processEnv);

  if (definition.provider === 'local') {
    if (!auth.passphrase) {
      throw new Error(`Vault "${vault}" requires passphrase-based authentication.`);
    }

    const metadata = await readVaultMetadata(storeRoot, vault);

    if (!metadata) {
      throw new Error(
        `Vault "${vault}" has not been initialized yet. Run cnos vault create ${vault} first.`,
      );
    }

    const derivedKey = deriveVaultKey(auth.passphrase, Buffer.from(metadata.salt, 'base64'), metadata.iterations);
    await listLocalSecrets(
      storeRoot,
      {
        derivedKey,
        method: auth.method,
        ...(definition.auth?.config ? { config: definition.auth.config } : {}),
      },
      vault,
    );
    const sessionPath = await writeVaultSessionKey(vault, derivedKey, options.processEnv);

    if (options.storeKeychain) {
      await writeKeychain(`cnos/${vault}`, derivedKey.toString('hex'));
    }

    return {
      name: vault,
      method: auth.method,
      storedInKeychain: options.storeKeychain ?? false,
      sessionPath,
    };
  }

  const sessionPath = await writeVaultSessionKey(vault, Buffer.from(vault, 'utf8'), options.processEnv);
  return {
    name: vault,
    method: auth.method,
    storedInKeychain: false,
    sessionPath,
  };
}

export async function logoutVault(
  name: string | undefined,
  options: RuntimeServiceOptions & { all?: boolean } = {},
): Promise<{ scope: string }> {
  if (options.all) {
    await clearAllVaultSessionKeys(options.processEnv);
    return { scope: 'all' };
  }

  const vault = name?.trim() || 'default';
  await clearVaultSessionKey(vault, options.processEnv);
  return { scope: vault };
}
