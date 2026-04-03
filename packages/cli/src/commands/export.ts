import type { RuntimeServiceOptions } from '../services/runtime.js';

import { runExportEnv } from './exportEnv.js';

export async function runExport(
  subcommand: string | undefined,
  options: RuntimeServiceOptions = {},
): Promise<string> {
  if ((subcommand ?? 'env') !== 'env') {
    throw new Error(`Unsupported export target: ${subcommand}`);
  }

  return runExportEnv(options);
}
