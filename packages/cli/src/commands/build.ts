import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { displayPath } from '../format/displayPath.js';
import { printJson } from '../format/printJson.js';
import { materializeEnvToFile } from '../services/envMaterialization.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';

export async function runBuild(
  subcommand: string | undefined,
  options: RuntimeServiceOptions = {},
): Promise<string> {
  if (subcommand !== 'env') {
    throw new Error(`Unsupported build target: ${subcommand ?? '(missing)'}`);
  }

  const infoArgs = [...(options.cliArgs ?? [])];
  const isPublic = consumeFlag(infoArgs, '--public');
  const framework = consumeOption(infoArgs, '--framework');
  consumeOption(infoArgs, '--prefix');
  const to = consumeOption(infoArgs, '--to');

  if (!to) {
    throw new Error('build env requires --to <path>');
  }

  const result = await materializeEnvToFile(to, {
    ...options,
    cliArgs: [...(options.cliArgs ?? [])],
  });

  if (options.json) {
    return printJson({
      to: result.targetPath,
      count: Object.keys(result.env).length,
      public: isPublic,
      ...(framework ? { framework } : {}),
    });
  }

  return `built env artifact at ${displayPath(result.targetPath, options.root ?? process.cwd())}`;
}
