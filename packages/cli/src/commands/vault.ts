import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import {
  createVaultDefinition,
  listLocalStoreVaults,
  listVaultDefinitions,
  removeVaultDefinition,
} from '../services/vaults.js';

function normalizeVaultAction(args: string[]): { action: 'create' | 'list' | 'remove'; tail: string[] } {
  const [action = 'list', ...tail] = args;

  if (['create', 'add', 'list', 'delete', 'remove'].includes(action)) {
    return {
      action:
        action === 'add' || action === 'create'
          ? 'create'
          : action === 'delete' || action === 'remove'
            ? 'remove'
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

  if (action === 'create') {
    const name = tail[0] ?? 'default';
    const provider = consumeOption(cliArgs, '--provider') ?? 'local';
    const passphrase = consumeOption(cliArgs, '--passphrase');
    const noPassphrase = consumeFlag(cliArgs, '--no-passphrase');
    const result = await createVaultDefinition(name, {
      ...options,
      cliArgs,
      provider,
      ...(passphrase ? { passphrase } : {}),
      ...(noPassphrase ? { noPassphrase: true } : {}),
    });

    if (options.json) {
      return printJson(result);
    }

    return `created vault "${result.name}" with provider "${result.provider}" in ${result.manifestPath}`;
  }

  if (action === 'remove') {
    const name = tail[0] ?? 'default';
    const result = await removeVaultDefinition(name, options);

    if (options.json) {
      return printJson(result);
    }

    return result.deleted ? `removed vault "${result.name}"` : `vault "${result.name}" was not found`;
  }

  const [manifestVaults, localStoreVaults] = await Promise.all([
    listVaultDefinitions(options),
    listLocalStoreVaults(options),
  ]);

  if (options.json) {
    return printJson(
      manifestVaults.map((vault) => ({
        ...vault,
        localStore: localStoreVaults.includes(vault.name),
      })),
    );
  }

  if (manifestVaults.length === 0) {
    return '';
  }

  return manifestVaults
    .map(
      (vault) =>
        `${vault.name} provider=${vault.provider} passphrase=${vault.passphrasePolicy}${
          localStoreVaults.includes(vault.name) ? ' local-store=true' : ''
        }`,
    )
    .join('\n');
}
