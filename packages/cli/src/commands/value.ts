import path from 'node:path';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { displayPath } from '../format/displayPath.js';
import { printJson } from '../format/printJson.js';
import { printValue } from '../format/printValue.js';
import { listConfigEntries } from '../services/listing.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';
import { defineValue, deleteValue } from '../services/writes.js';

function normalizeValueCommand(args: string[]): { action: 'get' | 'set' | 'list' | 'delete'; tail: string[] } {
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

export async function runValue(argsOrPath: string | string[], options: RuntimeServiceOptions = {}): Promise<string> {
  const args = Array.isArray(argsOrPath) ? argsOrPath : [argsOrPath];
  const { action, tail } = normalizeValueCommand(args);
  const cliArgs = [...(options.cliArgs ?? [])];
  const root = path.resolve(options.root ?? process.cwd());

  if (action === 'list') {
    const prefix = consumeOption(cliArgs, '--prefix');
    const entries = await listConfigEntries('value', {
      ...options,
      cliArgs,
      ...(prefix ? { prefix } : {}),
    });

    if (options.json) {
      return printJson(entries);
    }

    return entries.map((entry) => `${entry.key}=${printValue(entry.value)}${entry.derived ? '  (derived)' : ''}`).join('\n');
  }

  if (action === 'set') {
    const valuePath = tail[0] ?? 'app.name';
    const derive = consumeFlag(cliArgs, '--derive');
    const expr = consumeOption(cliArgs, '--expr');
    const deriveArg =
      derive && !expr && cliArgs[0] && !cliArgs[0].startsWith('--')
        ? cliArgs.shift()
        : undefined;
    const rawValue = derive ? '' : tail[1] ?? '';
    const deriveExpression = derive ? expr ?? tail[1] ?? deriveArg ?? '' : undefined;
    const target = (consumeOption(cliArgs, '--target') ?? 'local') as 'local' | 'global';
    const result = await defineValue('value', valuePath, rawValue, {
      ...options,
      cliArgs,
      target,
      ...(deriveExpression !== undefined
        ? {
            deriveExpression,
            deriveExprMode: Boolean(expr),
          }
        : {}),
    });

    if (options.json) {
      return printJson({
        namespace: 'value',
        path: valuePath,
        target,
        filePath: result.filePath,
        value: result.value,
      });
    }

    return `set value.${valuePath} in ${displayPath(result.filePath, root)}`;
  }

  if (action === 'delete') {
    const valuePath = tail[0] ?? 'app.name';
    const target = (consumeOption(cliArgs, '--target') ?? 'local') as 'local' | 'global';
    const result = await deleteValue('value', valuePath, {
      ...options,
      cliArgs,
      target,
    });

    if (options.json) {
      return printJson(result);
    }

    return result.deleted
      ? `deleted value.${valuePath} from ${displayPath(result.filePath, root)}`
      : `no value.${valuePath} found in ${displayPath(result.filePath, root)}`;
  }

  const runtime = await createRuntimeService(options);
  const value = runtime.value(tail[0] ?? 'app.name');

  if (value === undefined) {
    throw new Error(`Missing CNOS value path: ${tail[0] ?? 'app.name'}`);
  }

  if (options.json) {
    return printJson({
      key: `value.${tail[0] ?? 'app.name'}`,
      value,
    });
  }

  return printValue(value);
}
