import path from 'node:path';

import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { scaffoldWorkspace } from '../services/scaffold.js';

export async function runInit(options: RuntimeServiceOptions = {}): Promise<string> {
  const root = path.resolve(options.root ?? process.cwd());
  const workspace = options.workspace ?? path.basename(root);
  const result = await scaffoldWorkspace(root, workspace);

  if (options.json) {
    return printJson(result);
  }

  return `initialized CNOS workspace ${workspace} at ${root}`;
}
