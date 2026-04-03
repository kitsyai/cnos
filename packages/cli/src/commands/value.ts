import { printJson } from '../format/printJson.js';
import { printValue } from '../format/printValue.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';

export async function runValue(path: string, options: RuntimeServiceOptions = {}): Promise<string> {
  const runtime = await createRuntimeService(options);
  const value = runtime.value(path);

  if (value === undefined) {
    throw new Error(`Missing CNOS value path: ${path}`);
  }

  if (options.json) {
    return printJson({
      key: `value.${path}`,
      value,
    });
  }

  return printValue(value);
}
