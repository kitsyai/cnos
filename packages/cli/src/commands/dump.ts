import { writeDump } from '@kitsy/cnos';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';

export async function runDump(options: RuntimeServiceOptions = {}): Promise<string> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const flatten = consumeFlag(cliArgs, '--flatten');
  const to = consumeOption(cliArgs, '--to');

  if (!to) {
    throw new Error('dump requires --to <path>');
  }

  const runtime = await createRuntimeService({
    ...options,
    cliArgs,
  });
  const result = await writeDump(runtime.graph, {
    to,
    flatten,
  });

  if (options.json) {
    return printJson(result);
  }

  return `dumped ${result.files.length} files to ${result.root}`;
}
