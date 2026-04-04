import { copyFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { consumeFlag } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { scaffoldWorkspace } from '../services/scaffold.js';

const ROOT_ENV_FILE_PATTERN = /^\.env(?:\.[A-Za-z0-9_-]+)*(?:\.example)?$/;

export interface OnboardResult {
  root: string;
  workspace: string;
  scaffolded: string[];
  imported: string[];
  skipped: string[];
  mode: 'copy' | 'move';
}

async function listRootEnvFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && ROOT_ENV_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export async function runOnboard(options: RuntimeServiceOptions = {}): Promise<string> {
  const root = path.resolve(options.root ?? process.cwd());
  const workspace = options.workspace ?? path.basename(root);
  const cliArgs = [...(options.cliArgs ?? [])];
  const move = consumeFlag(cliArgs, '--move');

  if (cliArgs.length > 0) {
    throw new Error(`Unsupported onboard arguments: ${cliArgs.join(' ')}`);
  }

  const scaffold = await scaffoldWorkspace(root, workspace);
  const envRoot = path.join(root, 'cnos', 'workspaces', workspace, 'env');
  const rootFiles = await listRootEnvFiles(root);
  const imported: string[] = [];
  const skipped: string[] = [];

  for (const fileName of rootFiles) {
    const sourcePath = path.join(root, fileName);
    const targetPath = path.join(envRoot, fileName);

    try {
      await copyFile(sourcePath, targetPath);
      imported.push(path.relative(root, targetPath).replace(/\\/g, '/'));

      if (move) {
        await rm(sourcePath);
      }
    } catch {
      skipped.push(fileName);
    }
  }

  const result: OnboardResult = {
    root,
    workspace,
    scaffolded: scaffold.created,
    imported,
    skipped,
    mode: move ? 'move' : 'copy',
  };

  if (options.json) {
    return printJson(result);
  }

  const importedCount = imported.length;
  const skippedSuffix = skipped.length > 0 ? ` (${skipped.length} skipped)` : '';
  return `onboarded ${workspace} at ${root}; imported ${importedCount} root env files into cnos/workspaces/${workspace}/env using ${result.mode}${skippedSuffix}`;
}
