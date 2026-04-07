import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createSecretVault,
  loadManifest,
  listSecretVaults,
  resolveConfiguredVaultPassphrase,
  resolveSecretStoreRoot,
  resolveSecretVaultFile,
  resolveVaultDefinition,
  stringifyYaml,
  type ResolvedVaultDefinition,
  type VaultDefinition,
} from '@kitsy/cnos/internal';

import type { RuntimeServiceOptions } from './runtime.js';

export interface VaultRecord extends ResolvedVaultDefinition {
  passphrasePolicy: 'required' | 'none';
}

function sortVaults<T extends Record<string, unknown>>(vaults: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(vaults).sort(([left], [right]) => left.localeCompare(right)));
}

export async function createVaultDefinition(
  name: string,
  options: RuntimeServiceOptions & {
    provider?: string;
    passphrase?: string;
    noPassphrase?: boolean;
  } = {},
): Promise<VaultRecord & { manifestPath: string; storePath?: string }> {
  const vault = name.trim() || 'default';
  const provider = options.provider?.trim() || 'local';
  const noPassphrase = options.noPassphrase ?? false;

  if (provider === 'local' && noPassphrase) {
    throw new Error('Local vaults require a passphrase');
  }

  const loadedManifest = await loadManifest(options.root ? { root: options.root } : {});
  const processEnv = options.processEnv ?? process.env;
  const passphraseEnvVar = 'CNOS_SECRET_PASSPHRASE';
  const rawManifest = {
    ...loadedManifest.rawManifest,
    vaults: {
      ...(loadedManifest.rawManifest.vaults ?? {}),
      [vault]:
        provider === 'local'
          ? {
              provider: 'local',
              passphrase: `env:${passphraseEnvVar}`,
            }
          : {
              provider,
            },
    },
  };

  let storePath: string | undefined;

  if (provider === 'local') {
    const passphrase =
      options.passphrase ??
      resolveConfiguredVaultPassphrase(
        {
          provider: 'local',
          passphrase: `env:${passphraseEnvVar}`,
        },
        vault,
        processEnv,
      );

    if (!passphrase) {
      throw new Error(`Vault "${vault}" requires --passphrase or ${passphraseEnvVar}`);
    }

    storePath = await createSecretVault(resolveSecretStoreRoot(processEnv), vault, passphrase);
  }

  await writeFile(loadedManifest.manifestPath, stringifyYaml(rawManifest), 'utf8');

  return {
    ...resolveVaultDefinition(
      {
        [vault]: rawManifest.vaults[vault] as VaultDefinition,
      },
      vault,
    ),
    passphrasePolicy: provider === 'local' ? 'required' : 'none',
    manifestPath: loadedManifest.manifestPath,
    ...(storePath ? { storePath } : {}),
  };
}

export async function listVaultDefinitions(
  options: RuntimeServiceOptions = {},
): Promise<VaultRecord[]> {
  const loadedManifest = await loadManifest(options.root ? { root: options.root } : {});

  return Object.keys(loadedManifest.manifest.vaults)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const definition = resolveVaultDefinition(loadedManifest.manifest.vaults, name);
      return {
        ...definition,
        passphrasePolicy: definition.requiresPassphrase ? 'required' : 'none',
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

  const storeRoot = resolveSecretStoreRoot(options.processEnv);
  const vaultFile = resolveSecretVaultFile(storeRoot, vault);
  const vaultStoreRoot = path.join(storeRoot, 'vaults', vault);
  let removedStore: string | undefined;

  try {
    await readFile(vaultFile, 'utf8');
    await rm(vaultFile, { force: true });
    await rm(vaultStoreRoot, { recursive: true, force: true });
    removedStore = vaultStoreRoot;
  } catch {
    removedStore = undefined;
  }

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
