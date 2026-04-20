import path from 'node:path';

import { consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { scaffoldProject } from '../services/scaffold.js';

function parseWorkspaceList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function runInit(options: RuntimeServiceOptions = {}): Promise<string> {
  const root = path.resolve(options.root ?? process.cwd());
  const cliArgs = [...(options.cliArgs ?? [])];
  const modeOption = consumeOption(cliArgs, '--mode');
  const workspacesOption = consumeOption(cliArgs, '--workspaces');

  if (cliArgs.length > 0) {
    throw new Error(`Unsupported init arguments: ${cliArgs.join(' ')}`);
  }

  const mode =
    modeOption === undefined
      ? options.workspace
        ? 'workspace'
        : 'regular'
      : modeOption === 'workspace' || modeOption === 'regular'
        ? modeOption
        : undefined;

  if (!mode) {
    throw new Error(`Invalid value for --mode: ${modeOption}. Use "regular" or "workspace".`);
  }

  const workspaces = parseWorkspaceList(workspacesOption);
  const result = await scaffoldProject(root, {
    mode,
    ...(mode === 'workspace' ? { workspace: options.workspace ?? 'base', workspaces } : {}),
  });

  if (options.json) {
    return printJson(result);
  }

  if (result.mode === 'workspace' && result.workspace) {
    const suffix =
      result.workspaces && result.workspaces.length > 1
        ? ` (${result.workspaces.slice(1).join(', ')} extends ${result.workspace})`
        : '';
    return `initialized CNOS workspace project at ${root} with base workspace ${result.workspace}${suffix}`;
  }

  return `initialized CNOS project at ${root}`;
}
