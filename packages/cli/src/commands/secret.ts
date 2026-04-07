import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import { printValue } from '../format/printValue.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';
import { deleteSecret, setSecret } from '../services/writes.js';
import { listConfigEntries } from '../services/listing.js';
import { runVault } from './vault.js';

function isSecretRef(value: unknown): value is { provider: string; ref: string; vault?: string } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { provider?: unknown }).provider === 'string' &&
      typeof (value as { ref?: unknown }).ref === 'string',
  );
}

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

export async function runSecret(argsOrPath: string | string[], options: RuntimeServiceOptions = {}): Promise<string> {
  const args = Array.isArray(argsOrPath) ? argsOrPath : [argsOrPath];
  const { action, tail } = normalizeSecretCommand(args);
  const cliArgs = [...(options.cliArgs ?? [])];

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

    return entries.map((entry) => `${entry.key}=${printValue(entry.value)}`).join('\n');
  }

  if (action === 'set') {
    const secretPath = tail[0];
    const rawValue = tail[1] ?? '';
    const local = consumeFlag(cliArgs, '--local');
    const remote = consumeFlag(cliArgs, '--remote');
    const ref = consumeFlag(cliArgs, '--ref');
    const target = (consumeOption(cliArgs, '--target') ?? 'local') as 'local' | 'global';
    const provider = consumeOption(cliArgs, '--provider');
    const passphrase = consumeOption(cliArgs, '--passphrase');
    const vault = consumeOption(cliArgs, '--vault') ?? 'default';
    const mode = local ? 'local' : remote ? 'remote' : ref ? 'ref' : undefined;
    const result = await setSecret(secretPath ?? 'app.token', rawValue, {
      ...options,
      cliArgs,
      target,
      vault,
      ...(mode ? { mode } : {}),
      ...(provider ? { provider } : {}),
      ...(passphrase ? { passphrase } : {}),
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
  const entry = runtime.graph.entries.get(`secret.${secretPath}`);
  const secretRef = entry?.winner.metadata?.secretRef as { provider?: string; ref?: string; vault?: string } | undefined;
  const value = runtime.secret(secretPath);

  if (value === undefined) {
    throw new Error(`Missing CNOS secret path: ${secretPath}`);
  }

  if (expectedVault && secretRef?.vault && secretRef.vault !== expectedVault) {
    throw new Error(`Secret ${secretPath} belongs to vault "${secretRef.vault}", not "${expectedVault}"`);
  }

  if (isSecretRef(value)) {
    if (value.provider === 'local') {
      const vault = value.vault ?? 'default';
      throw new Error(
        `Secret ${secretPath} is stored in vault "${vault}" as ref "${value.ref}". Provide the correct vault passphrase to resolve it.`,
      );
    }

    if (value.provider === 'github-secrets') {
      throw new Error(
        `Secret ${secretPath} is backed by GitHub secrets via ref "${value.ref}". Set that env var in the current process or CI job to resolve it.`,
      );
    }

    throw new Error(`Secret ${secretPath} is stored as a ${value.provider} reference "${value.ref}" and is not resolved.`);
  }

  if (options.json) {
    return printJson({
      key: `secret.${secretPath}`,
      value,
    });
  }

  return printValue(value);
}
