import path from 'node:path';

import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { scaffoldWorkspace } from '../services/scaffold.js';

export async function runInit(options: RuntimeServiceOptions = {}): Promise<string> {
  const root = path.resolve(options.root ?? process.cwd());
  const result = await scaffoldWorkspace(root, options.workspace);

  if (options.json) {
    return printJson(result);
  }

  if (result.workspace) {
    return `initialized CNOS workspace ${result.workspace} at ${root}`;
  }

  return `initialized CNOS project at ${root}`;
}
