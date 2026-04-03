import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';
import { printJson } from '../format/printJson.js';
import { printValue } from '../format/printValue.js';

export async function runSecret(path: string, options: RuntimeServiceOptions = {}): Promise<string> {
  const runtime = await createRuntimeService(options);
  const value = runtime.secret(path);

  if (value === undefined) {
    throw new Error(`Missing CNOS secret path: ${path}`);
  }

  if (options.json) {
    return printJson({
      key: `secret.${path}`,
      value,
    });
  }

  return printValue(value);
}
