import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import { printValue } from '../format/printValue.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';
import { deleteSecret, setSecret } from '../services/writes.js';

function isSecretRef(value: unknown): value is { provider: string; ref: string } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { provider?: unknown }).provider === 'string' &&
      typeof (value as { ref?: unknown }).ref === 'string',
  );
}

function normalizeSecretCommand(args: string[]): { action: 'get' | 'set' | 'list' | 'delete'; tail: string[] } {
  const [actionOrPath, ...tail] = args;

  if (!actionOrPath) {
    return {
      action: 'list',
      tail: [],
    };
  }

  if (['get', 'set', 'create', 'add', 'list', 'delete', 'remove'].includes(actionOrPath)) {
    return {
      action:
        actionOrPath === 'remove'
          ? 'delete'
          : actionOrPath === 'create' || actionOrPath === 'add'
            ? 'set'
            : (actionOrPath as 'get' | 'set' | 'list' | 'delete'),
      tail,
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

  if (action === 'list') {
    const runtime = await createRuntimeService(options);
    const secrets = runtime.toNamespace('secret');

    if (options.json) {
      return printJson(secrets);
    }

    return Object.entries(secrets)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${printValue(value)}`)
      .join('\n');
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
    const mode = local ? 'local' : remote ? 'remote' : ref ? 'ref' : 'local';
    const result = await setSecret(secretPath ?? 'app.token', rawValue, {
      ...options,
      cliArgs,
      target,
      mode,
      ...(provider ? { provider } : {}),
      ...(passphrase ? { passphrase } : {}),
    });

    if (options.json) {
      return printJson(result);
    }

    return `set secret.${secretPath} via ${result.provider} in ${result.filePath}`;
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
  const value = runtime.secret(tail[0] ?? 'app.token');

  if (value === undefined) {
    throw new Error(`Missing CNOS secret path: ${tail[0] ?? 'app.token'}`);
  }

  if (isSecretRef(value)) {
    throw new Error(
      `Secret ${tail[0] ?? 'app.token'} is stored as an unresolved ${value.provider} reference. Provide the required provider context to resolve it.`,
    );
  }

  if (options.json) {
    return printJson({
      key: `secret.${tail[0] ?? 'app.token'}`,
      value,
    });
  }

  return printValue(value);
}
