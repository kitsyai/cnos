import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { displayPath } from '../format/displayPath.js';
import { printJson } from '../format/printJson.js';
import {
  materializeEnvToFile,
  resolveMaterializedEnv,
} from '../services/envMaterialization.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';

export async function runExportEnv(options: RuntimeServiceOptions = {}): Promise<string> {
  const infoArgs = [...(options.cliArgs ?? [])];
  const isPublic = consumeFlag(infoArgs, '--public');
  const framework = consumeOption(infoArgs, '--framework');
  consumeOption(infoArgs, '--prefix');
  const to = consumeOption(infoArgs, '--to');
  const baseOptions = {
    ...options,
    cliArgs: [...(options.cliArgs ?? [])],
  };

  if (to) {
    const result = await materializeEnvToFile(to, baseOptions);

    if (options.json) {
      return printJson({
        to: result.targetPath,
        count: Object.keys(result.env).length,
        public: isPublic,
        ...(framework ? { framework } : {}),
      });
    }

    return `Wrote ${Object.keys(result.env).length} env vars to ${displayPath(result.targetPath, options.root ?? process.cwd())}`;
  }

  const result = await resolveMaterializedEnv(baseOptions);

  if (options.json) {
    return printJson(result.env);
  }

  return result.output;
}
