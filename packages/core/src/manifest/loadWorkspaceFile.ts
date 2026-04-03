import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { CnosManifestError } from '../errors.js';
import type { WorkspaceFile } from '../types/workspace.js';
import { parseYaml } from '../utils/yaml.js';

export interface LoadedWorkspaceFile {
  path: string;
  config: WorkspaceFile;
}

export async function loadWorkspaceFile(repoRoot: string): Promise<LoadedWorkspaceFile | undefined> {
  const workspaceFilePath = path.join(repoRoot, '.cnos-workspace.yml');

  try {
    const source = await readFile(workspaceFilePath, 'utf8');
    const parsed = parseYaml<unknown>(source);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CnosManifestError('.cnos-workspace.yml must be a YAML object', workspaceFilePath);
    }

    const config = parsed as WorkspaceFile;

    return {
      path: workspaceFilePath,
      config: {
        ...(config.workspace ? { workspace: config.workspace.trim() } : {}),
        ...(config.globalRoot ? { globalRoot: config.globalRoot.trim() } : {}),
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}
