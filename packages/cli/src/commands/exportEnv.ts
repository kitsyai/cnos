import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';

export async function runExportEnv(options: RuntimeServiceOptions = {}): Promise<string> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const isPublic = consumeFlag(cliArgs, '--public');
  const framework = consumeOption(cliArgs, '--framework');
  const prefix = consumeOption(cliArgs, '--prefix');
  const runtime = await createRuntimeService({
    ...options,
    cliArgs,
  });
  const env = isPublic
    ? runtime.toPublicEnv({
        ...(framework ? { framework } : {}),
        ...(prefix ? { prefix } : {}),
      })
    : Object.fromEntries(
        Object.entries(runtime.manifest.envMapping.explicit)
          .map(([envVar, logicalKey]) => [envVar, runtime.read(logicalKey)])
          .filter((entry): entry is [string, string | number | boolean | bigint | object] => entry[1] !== undefined)
          .map(([envVar, value]) => [
            envVar,
            typeof value === 'string'
              ? value
              : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
                ? String(value)
                : JSON.stringify(value),
          ]),
      );

  if (options.json) {
    return printJson(env);
  }

  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}
