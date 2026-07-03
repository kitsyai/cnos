import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';

import { consumeFlag, consumeOption, consumePrivateFlag } from '../cli/commandOptions.js';
import { displayPath } from '../format/displayPath.js';
import { printJson } from '../format/printJson.js';
import { printTable } from '../format/printTable.js';
import { printValue } from '../format/printValue.js';
import { maskSecretValue } from '../format/maskSecret.js';
import { listConfigEntries } from '../services/listing.js';
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

async function promptHiddenValue(message: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Cannot prompt for a secret value in non-interactive mode. Pass <value> explicitly or use --stdin.');
  }

  const mutableStdout = new WritableMask();
  const rl = readline.createInterface({
    input: process.stdin,
    output: mutableStdout,
    terminal: true,
  });

  try {
    mutableStdout.muted = true;
    const value = await new Promise<string>((resolve) => {
      rl.question(message, resolve);
    });
    process.stdout.write('\n');
    return value;
  } finally {
    rl.close();
  }
}

async function shouldPromptForMissingSecretValue(
  vault: string,
  mode: 'local' | 'remote' | 'ref' | undefined,
  options: RuntimeServiceOptions,
): Promise<boolean> {
  if (mode === 'local') {
    return true;
  }

  if (mode === 'remote' || mode === 'ref') {
    return false;
  }

  const runtime = await createRuntimeService({
    ...options,
    secretResolution: 'lazy',
  });

  return runtime.manifest.vaults[vault]?.provider === 'local';
}

async function resolveSecretSetValue(
  secretPath: string,
  providedValue: string | undefined,
  stdin: boolean,
  promptForMissingValue: boolean,
): Promise<string> {
  if (stdin) {
    return readStdinValue();
  }

  if (providedValue !== undefined) {
    return providedValue;
  }

  if (promptForMissingValue) {
    return promptHiddenValue(`Enter value for secret "${secretPath}": `);
  }

  return secretPath;
}

class WritableMask extends Writable {
  muted = false;

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) {
      process.stdout.write(chunk);
    }

    callback();
  }
}

export async function runSecret(argsOrPath: string | string[], options: RuntimeServiceOptions = {}): Promise<string> {
  const args = Array.isArray(argsOrPath) ? argsOrPath : [argsOrPath];
  const { action, tail } = normalizeSecretCommand(args);
  const cliArgs = [...(options.cliArgs ?? [])];
  const root = path.resolve(options.root ?? process.cwd());

  if (consumeOption(cliArgs, '--passphrase')) {
    throw new Error('The --passphrase option is not supported in CNOS 1.4. Use env, keychain, or prompt-based auth.');
  }

  if (action === 'create-vault') {
    return runVault(['create', tail[0] ?? 'default'], options);
  }

  if (action === 'list') {
    const prefix = consumeOption(cliArgs, '--prefix');
    const vault = consumeOption(cliArgs, '--vault');
    const provider = consumeOption(cliArgs, '--provider');
    const entries = await listConfigEntries('secret', {
      ...options,
      cliArgs,
      ...(prefix ? { prefix } : {}),
      ...(vault ? { vault } : {}),
      ...(provider ? { provider } : {}),
    });

    if (options.json) {
      return printJson(entries);
    }

    return printTable(
      entries.map((entry) => ({
        key: entry.key,
        value: printValue(entry.value),
        vault: entry.vault ?? 'default',
        provider: entry.provider ?? 'local',
      })),
    );
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
    const writePrivate = consumePrivateFlag(cliArgs);
    const resolvedSecretPath = secretPath ?? 'app.token';
    const promptForMissingValue = await shouldPromptForMissingSecretValue(vault, mode, {
      ...options,
      cliArgs,
      target,
    });
    const rawValue = await resolveSecretSetValue(resolvedSecretPath, tail[1], stdin, promptForMissingValue);
    const result = await setSecret(resolvedSecretPath, rawValue, {
      ...options,
      writePrivate,
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
      ? `set secret.${secretPath} in vault "${result.vault ?? 'default'}" with ref "${result.ref}" and repo pointer ${displayPath(result.filePath, root)}`
      : `added secret reference secret.${secretPath} -> ref "${result.ref}" in vault "${result.vault ?? 'default'}" using provider "${result.provider}" at ${displayPath(result.filePath, root)}. No secret material was written by CNOS; create or update the secret in the configured vault separately.`;
  }

  if (action === 'delete') {
    const secretPath = tail[0];
    const target = (consumeOption(cliArgs, '--target') ?? 'local') as 'local' | 'global';
    const writePrivate = consumePrivateFlag(cliArgs);
    const result = await deleteSecret(secretPath ?? 'app.token', {
      ...options,
      writePrivate,
      cliArgs,
      target,
    });

    if (options.json) {
      return printJson(result);
    }

    return result.deleted
      ? `deleted secret.${secretPath} from ${displayPath(result.filePath, root)}`
      : `no secret.${secretPath} found in ${displayPath(result.filePath, root)}`;
  }

  const runtime = await createRuntimeService({
    ...options,
    secretResolution: 'lazy',
  });
  const secretPath = tail[0] ?? 'app.token';
  const expectedVault = consumeOption(cliArgs, '--vault');
  const reveal = consumeFlag(cliArgs, '--reveal');
  const entry = runtime.graph.entries.get(`secret.${secretPath}`);
  const secretRef = entry?.winner.metadata?.secretRef as { provider?: string; ref?: string; vault?: string } | undefined;

  await runtime.refreshSecret(`secret.${secretPath}`);
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
