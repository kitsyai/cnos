import { maskSecretValue } from '../format/maskSecret.js';
import { printJson } from '../format/printJson.js';
import { printInspect } from '../format/printInspect.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';

export async function runInspect(
  key: string,
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const reveal = options.cliArgs?.includes('--reveal') ?? false;
  const runtime = await createRuntimeService(options);
  const inspectResult = runtime.inspect(key);
  const value =
    key.startsWith('secret.') && !reveal
      ? maskSecretValue(inspectResult.value)
      : inspectResult.value;
  const printable = {
    ...inspectResult,
    value,
    overridden: inspectResult.overridden.map((entry) => ({
      ...entry,
      value: key.startsWith('secret.') && !reveal ? maskSecretValue(entry.value) : entry.value,
    })),
  };

  if (options.json) {
    return printJson(printable);
  }

  return printInspect(printable);
}
