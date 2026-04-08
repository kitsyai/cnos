import { watchSchema, writeCodegenOutput } from '@kitsy/cnos/internal';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';

export async function runCodegen(options: RuntimeServiceOptions = {}): Promise<string> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const out = consumeOption(cliArgs, '--out');
  const watch = consumeFlag(cliArgs, '--watch');

  if (cliArgs.length > 0) {
    throw new Error(`Unknown codegen options: ${cliArgs.join(' ')}`);
  }

  if (watch) {
    const watcher = await watchSchema({
      ...(options.root
        ? {
            root: options.root,
          }
        : {}),
      ...(out
        ? {
            out,
          }
        : {}),
      onError(error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
      },
    });

    const closeWatcher = (): void => {
      watcher.close();
    };

    process.once('SIGINT', closeWatcher);
    process.once('SIGTERM', closeWatcher);

    return `watching schema changes -> ${out ?? '.cnos/types/cnos.d.ts'}`;
  }

  const result = await writeCodegenOutput({
    ...(options.root
      ? {
          root: options.root,
        }
      : {}),
    ...(out
      ? {
          out,
        }
      : {}),
  });
  const summary = result.hasSchema
    ? `generated types from ${result.schemaEntryCount} schema entr${result.schemaEntryCount === 1 ? 'y' : 'ies'}`
    : 'generated empty types (no schema section found)';

  return `${summary} -> ${result.typesPath} and ${result.runtimePath}`;
}
