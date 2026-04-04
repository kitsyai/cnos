import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseYaml, stringifyYaml, type WorkspaceFile } from '@kitsy/cnos-core';

export interface UseContextOptions {
  root?: string;
  workspace?: string;
  profile?: string;
  globalRoot?: string;
}

export async function loadCliContext(root = process.cwd()): Promise<WorkspaceFile> {
  const filePath = path.join(path.resolve(root), '.cnos-workspace.yml');

  try {
    const source = await readFile(filePath, 'utf8');
    const parsed = parseYaml<unknown>(source);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return parsed as WorkspaceFile;
  } catch {
    return {};
  }
}

export async function saveCliContext(
  options: UseContextOptions = {},
): Promise<{ filePath: string; context: WorkspaceFile }> {
  const root = path.resolve(options.root ?? process.cwd());
  const filePath = path.join(root, '.cnos-workspace.yml');
  const current = await loadCliContext(root);
  const next: WorkspaceFile = {
    ...(current.workspace ? { workspace: current.workspace } : {}),
    ...(current.profile ? { profile: current.profile } : {}),
    ...(current.globalRoot ? { globalRoot: current.globalRoot } : {}),
    ...(options.workspace ? { workspace: options.workspace } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.globalRoot ? { globalRoot: options.globalRoot } : {}),
  };

  await writeFile(filePath, stringifyYaml(next), 'utf8');

  return {
    filePath,
    context: next,
  };
}
