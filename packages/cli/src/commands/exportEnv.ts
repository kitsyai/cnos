import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';

function formatEnvOutput(env: Record<string, string>): string {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export async function runExportEnv(options: RuntimeServiceOptions = {}): Promise<string> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const isPublic = consumeFlag(cliArgs, '--public');
  const framework = consumeOption(cliArgs, '--framework');
  const prefix = consumeOption(cliArgs, '--prefix');
  const to = consumeOption(cliArgs, '--to');
  const runtime = await createRuntimeService({
    ...options,
    cliArgs,
  });
  const env = isPublic
    ? runtime.toPublicEnv({
        ...(framework ? { framework } : {}),
        ...(prefix ? { prefix } : {}),
      })
    : runtime.toEnv();
  const output = formatEnvOutput(env);

  if (to) {
    const targetPath = path.resolve(options.root ?? process.cwd(), to);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, output, 'utf8');

    if (options.json) {
      return printJson({
        to: targetPath,
        count: Object.keys(env).length,
        public: isPublic,
        ...(framework ? { framework } : {}),
      });
    }

    return `Wrote ${Object.keys(env).length} env vars to ${targetPath}`;
  }

  if (options.json) {
    return printJson(env);
  }

  return output;
}
