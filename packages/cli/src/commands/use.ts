import path from 'node:path';

import { displayPath } from '../format/displayPath.js';
import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { loadCliContext, saveCliContext } from '../services/context.js';

export async function runUse(args: string[] = [], options: RuntimeServiceOptions = {}): Promise<string> {
  const root = path.resolve(options.root ?? process.cwd());
  const action = args[0];
  const hasUpdates = Boolean(options.workspace || options.profile || options.globalRoot);

  if (action === 'show' || (!action && !hasUpdates)) {
    const context = await loadCliContext(root);

    if (options.json) {
      return printJson(context);
    }

    return Object.keys(context).length === 0 ? 'no CLI context configured' : printJson(context);
  }

  const result = await saveCliContext({
    root,
    ...(options.workspace ? { workspace: options.workspace } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.globalRoot ? { globalRoot: options.globalRoot } : {}),
  });

  if (options.json) {
    return printJson(result);
  }

  return `updated CLI context in ${displayPath(result.filePath, root)}`;
}
