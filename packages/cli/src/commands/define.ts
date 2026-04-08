import path from 'node:path';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { displayPath } from '../format/displayPath.js';
import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { defineValue } from '../services/writes.js';

export async function runDefine(
  namespace: 'value' | 'secret',
  configPath: string,
  rawValue: string,
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const root = path.resolve(options.root ?? process.cwd());
  const target = (consumeOption(cliArgs, '--target') ?? 'local') as 'local' | 'global';
  const local = consumeFlag(cliArgs, '--local');
  const remote = consumeFlag(cliArgs, '--remote');
  const ref = consumeFlag(cliArgs, '--ref');
  const provider = consumeOption(cliArgs, '--provider');
  const passphrase = consumeOption(cliArgs, '--passphrase');
  const result = await defineValue(namespace, configPath, rawValue, {
    ...options,
    cliArgs,
    target,
    ...(namespace === 'secret'
      ? {
          mode: local ? 'local' : remote ? 'remote' : ref ? 'ref' : 'local',
          ...(provider ? { provider } : {}),
          ...(passphrase ? { passphrase } : {}),
        }
      : {}),
  });

  if (options.json) {
    return printJson({
      namespace,
      path: configPath,
      target,
      filePath: result.filePath,
      value: result.value,
    });
  }

  return `defined ${namespace}.${configPath} in ${displayPath(result.filePath, root)}`;
}
