import path from 'node:path';

import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { saveCliContext } from '../services/context.js';

export async function runUse(options: RuntimeServiceOptions = {}): Promise<string> {
  const root = path.resolve(options.root ?? process.cwd());
  const result = await saveCliContext({
    root,
    ...(options.workspace ? { workspace: options.workspace } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.globalRoot ? { globalRoot: options.globalRoot } : {}),
  });

  if (options.json) {
    return printJson(result);
  }

  return `updated CLI context in ${result.filePath}`;
}
