import { consumeFlag } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import { maskSecretValue } from '../format/maskSecret.js';
import { printValue } from '../format/printValue.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';

export async function runRead(key: string, options: RuntimeServiceOptions = {}): Promise<string> {
  const runtime = await createRuntimeService(options);
  const value = runtime.read(key);

  if (value === undefined) {
    throw new Error(`Missing CNOS config key: ${key}`);
  }

  const isSecret = key.startsWith('secret.');
  const cliArgs = [...(options.cliArgs ?? [])];
  const reveal = consumeFlag(cliArgs, '--reveal');
  const valueForOutput = isSecret && !reveal ? maskSecretValue(value) : value;

  if (options.json) {
    return printJson({ key, value: valueForOutput });
  }

  return printValue(valueForOutput);
}
