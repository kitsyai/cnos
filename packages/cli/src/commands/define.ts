import { consumeOption } from '../cli/commandOptions.js';
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
  const target = (consumeOption(cliArgs, '--target') ?? 'local') as 'local' | 'global';
  const result = await defineValue(namespace, configPath, rawValue, {
    ...options,
    cliArgs,
    target,
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

  return `defined ${namespace}.${configPath} in ${result.filePath}`;
}
