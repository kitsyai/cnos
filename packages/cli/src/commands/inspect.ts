import { printJson } from '../format/printJson.js';
import { printInspect } from '../format/printInspect.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';

export async function runInspect(
  key: string,
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const runtime = await createRuntimeService(options);
  const inspectResult = runtime.inspect(key);

  if (options.json) {
    return printJson(inspectResult);
  }

  return printInspect(inspectResult);
}
