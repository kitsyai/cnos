import path from 'node:path';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { displayPath } from '../format/displayPath.js';
import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import {
  authenticateVault,
  createVaultDefinition,
  listLocalStoreVaults,
  listVaultDefinitions,
  type VaultRecord,
  logoutVault,
  removeVaultDefinition,
} from '../services/vaults.js';

function normalizeVaultAction(args: string[]): { action: 'create' | 'list' | 'remove' | 'auth' | 'logout'; tail: string[] } {
  const [action = 'list', ...tail] = args;

  if (['create', 'add', 'list', 'delete', 'remove', 'auth', 'logout'].includes(action)) {
    return {
      action:
        action === 'add' || action === 'create'
          ? 'create'
          : action === 'delete' || action === 'remove'
            ? 'remove'
            : action === 'auth'
              ? 'auth'
              : action === 'logout'
                ? 'logout'
                : 'list',
      tail,
    };
  }

  return {
    action: 'list',
    tail: args,
  };
}

export async function runVault(args: string[] = [], options: RuntimeServiceOptions = {}): Promise<string> {
  const { action, tail } = normalizeVaultAction(args);
  const cliArgs = [...(options.cliArgs ?? [])];
  const root = path.resolve(options.root ?? process.cwd());

  if (consumeOption(cliArgs, '--passphrase')) {
    throw new Error('The --passphrase option is not supported in CNOS 1.4. Use env, keychain, or prompt-based auth.');
  }

  if (action === 'create') {
    const name = tail[0] ?? 'default';
    const provider = consumeOption(cliArgs, '--provider') ?? 'local';
    const noPassphrase = consumeFlag(cliArgs, '--no-passphrase');
    const result = await createVaultDefinition(name, {
      ...options,
      cliArgs,
      provider,
      ...(noPassphrase ? { noPassphrase: true } : {}),
    });

    if (options.json) {
      return printJson(result);
    }

    return `created vault "${result.name}" with provider "${result.provider}" in ${displayPath(result.manifestPath, root)}`;
  }

  if (action === 'auth') {
    const result = await authenticateVault(tail[0] ?? 'default', {
      ...options,
      cliArgs,
      storeKeychain: consumeFlag(cliArgs, '--store-keychain'),
    });

    if (options.json) {
      return printJson(result);
    }

    return `authenticated vault "${result.name}" via ${result.method}`;
  }

  if (action === 'logout') {
    const result = await logoutVault(tail[0], {
      ...options,
      cliArgs,
      all: consumeFlag(cliArgs, '--all'),
    });

    if (options.json) {
      return printJson(result);
    }

    return result.scope === 'all' ? 'logged out all vault sessions' : `logged out vault "${result.scope}"`;
  }

  if (action === 'remove') {
    const name = tail[0] ?? 'default';
    const result = await removeVaultDefinition(name, options);

    if (options.json) {
      return printJson(result);
    }

    return result.deleted ? `removed vault "${result.name}"` : `vault "${result.name}" was not found`;
  }

  const localStoreVaults = await listLocalStoreVaults(options);
  let manifestVaults: VaultRecord[] = [];

  try {
    manifestVaults = await listVaultDefinitions(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!message.includes('No .cnosrc.yml found') && !message.includes('Could not locate .cnos/cnos.yml')) {
      throw error;
    }
  }

  const manifestNames = new Set(manifestVaults.map((vault) => vault.name));
  const localOnlyVaults = localStoreVaults
    .filter((name) => !manifestNames.has(name))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      provider: 'local',
      authMethod: 'passphrase',
      localStore: true,
      source: 'local-store',
    }));

  if (options.json) {
    return printJson(
      [
        ...manifestVaults.map((vault) => ({
          ...vault,
          localStore: localStoreVaults.includes(vault.name),
        })),
        ...localOnlyVaults,
      ],
    );
  }

  const vaults = [
    ...manifestVaults.map((vault) => ({
      name: vault.name,
      provider: vault.provider,
      authMethod: vault.authMethod,
      localStore: localStoreVaults.includes(vault.name),
      source: undefined,
    })),
    ...localOnlyVaults,
  ];

  if (vaults.length === 0) {
    return '';
  }

  return vaults
    .map(
      (vault) =>
        `${vault.name} provider=${vault.provider} auth=${vault.authMethod}${
          vault.localStore ? ' local-store=true' : ''
        }${vault.source ? ` source=${vault.source}` : ''}`,
    )
    .join('\n');
}
