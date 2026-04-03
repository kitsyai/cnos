import { printJson } from '../format/printJson.js';
import { printValue } from '../format/printValue.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';

export async function runRead(key: string, options: RuntimeServiceOptions = {}): Promise<string> {
  const runtime = await createRuntimeService(options);
  const value = runtime.read(key);

  if (value === undefined) {
    throw new Error(`Missing CNOS config key: ${key}`);
  }

  if (options.json) {
    return printJson({ key, value });
  }

  return printValue(value);
}
