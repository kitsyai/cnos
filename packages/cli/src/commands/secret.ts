import { readFile } from 'node:fs/promises';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import { printValue } from '../format/printValue.js';
import { maskSecretValue } from '../format/maskSecret.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';
import { deleteSecret, setSecret } from '../services/writes.js';
import { runVault } from './vault.js';

function normalizeSecretCommand(
  args: string[],
): { action: 'get' | 'set' | 'list' | 'delete' | 'create-vault'; tail: string[] } {
  const [actionOrPath, next, ...tail] = args;

  if (!actionOrPath) {
    return {
      action: 'list',
      tail: [],
    };
  }

  if ((actionOrPath === 'create' || actionOrPath === 'add') && next === 'vault') {
    return {
      action: 'create-vault',
      tail,
    };
  }

  if (['get', 'set', 'list', 'delete', 'remove'].includes(actionOrPath)) {
    return {
      action: actionOrPath === 'remove' ? 'delete' : (actionOrPath as 'get' | 'set' | 'list' | 'delete'),
      tail: [next, ...tail].filter((value): value is string => Boolean(value)),
    };
  }

  return {
    action: 'get',
    tail: args,
  };
}

async function readStdinValue(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8').trimEnd();
}

export async function runSecret(argsOrPath: string | string[], options: RuntimeServiceOptions = {}): Promise<string> {
  const args = Array.isArray(argsOrPath) ? argsOrPath : [argsOrPath];
  const { action, tail } = normalizeSecretCommand(args);
  const cliArgs = [...(options.cliArgs ?? [])];

  if (consumeOption(cliArgs, '--passphrase')) {
    throw new Error('The --passphrase option is not supported in CNOS 1.4. Use env, keychain, or prompt-based auth.');
  }

  if (action === 'create-vault') {
    return runVault(['create', tail[0] ?? 'default'], options);
  }

  if (action === 'list') {
    const runtime = await createRuntimeService(options);
    const prefix = consumeOption(cliArgs, '--prefix');
    const vault = consumeOption(cliArgs, '--vault');
    const provider = consumeOption(cliArgs, '--provider');
    const entries = Array.from(runtime.graph.entries.values())
      .filter((entry) => entry.namespace === 'secret')
      .filter((entry) => !prefix || entry.key.startsWith(`secret.${prefix}`) || entry.key.startsWith(prefix))
      .filter((entry) => {
        const secretRef = entry.winner.metadata?.secretRef as { provider?: string; vault?: string } | undefined;
        if (vault && secretRef?.vault !== vault) {
          return false;
        }

        if (provider && secretRef?.provider !== provider) {
          return false;
        }

        return true;
      })
      .map((entry) => {
        const secretRef = entry.winner.metadata?.secretRef as { provider?: string; vault?: string } | undefined;
        return {
          key: entry.key,
          vault: secretRef?.vault ?? 'default',
          provider: secretRef?.provider ?? 'local',
        };
      })
      .sort((left, right) => left.key.localeCompare(right.key));

    if (options.json) {
      return printJson(entries);
    }

    return entries.map((entry) => `${entry.key} (vault: ${entry.vault}, provider: ${entry.provider})`).join('\n');
  }

  if (action === 'set') {
    const secretPath = tail[0];
    const local = consumeFlag(cliArgs, '--local');
    const remote = consumeFlag(cliArgs, '--remote');
    const ref = consumeFlag(cliArgs, '--ref');
    const stdin = consumeFlag(cliArgs, '--stdin');
    const target = (consumeOption(cliArgs, '--target') ?? 'local') as 'local' | 'global';
    const provider = consumeOption(cliArgs, '--provider');
    const vault = consumeOption(cliArgs, '--vault') ?? 'default';
    const mode = local ? 'local' : remote ? 'remote' : ref ? 'ref' : undefined;
    const rawValue = stdin ? await readStdinValue() : tail[1] ?? '';
    const result = await setSecret(secretPath ?? 'app.token', rawValue, {
      ...options,
      cliArgs,
      target,
      vault,
      ...(mode ? { mode } : {}),
      ...(provider ? { provider } : {}),
    });

    if (options.json) {
      return printJson(result);
    }

    return result.provider === 'local'
      ? `set secret.${secretPath} in vault "${result.vault ?? 'default'}" with ref "${result.ref}" and repo pointer ${result.filePath}`
      : `set secret.${secretPath} via ${result.provider} in ${result.filePath}`;
  }

  if (action === 'delete') {
    const secretPath = tail[0];
    const target = (consumeOption(cliArgs, '--target') ?? 'local') as 'local' | 'global';
    const result = await deleteSecret(secretPath ?? 'app.token', {
      ...options,
      cliArgs,
      target,
    });

    if (options.json) {
      return printJson(result);
    }

    return result.deleted
      ? `deleted secret.${secretPath} from ${result.filePath}`
      : `no secret.${secretPath} found in ${result.filePath}`;
  }

  const runtime = await createRuntimeService(options);
  const secretPath = tail[0] ?? 'app.token';
  const expectedVault = consumeOption(cliArgs, '--vault');
  const reveal = consumeFlag(cliArgs, '--reveal');
  const entry = runtime.graph.entries.get(`secret.${secretPath}`);
  const secretRef = entry?.winner.metadata?.secretRef as { provider?: string; ref?: string; vault?: string } | undefined;
  const value = runtime.secret(secretPath);

  if (value === undefined) {
    throw new Error(`Missing CNOS secret path: ${secretPath}`);
  }

  if (expectedVault && secretRef?.vault && secretRef.vault !== expectedVault) {
    throw new Error(`Secret ${secretPath} belongs to vault "${secretRef.vault}", not "${expectedVault}"`);
  }

  const valueForOutput = reveal ? value : maskSecretValue(value);

  if (options.json) {
    return printJson({
      key: `secret.${secretPath}`,
      value: valueForOutput,
      vault: secretRef?.vault ?? 'default',
    });
  }

  return printValue(valueForOutput);
}
