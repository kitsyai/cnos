import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ScaffoldWorkspaceResult {
  root: string;
  mode: 'regular' | 'workspace';
  workspace?: string;
  workspaces?: string[];
  created: string[];
}

export interface ScaffoldManifestOptions {
  mode?: 'regular' | 'workspace';
  workspace?: string;
  workspaces?: string[];
}

export function scaffoldManifest(projectName: string, options: ScaffoldManifestOptions = {}): string {
  const mode = options.mode ?? 'regular';
  const baseWorkspace = options.workspace ?? 'base';
  const workspaceIds =
    mode === 'workspace'
      ? [baseWorkspace, ...(options.workspaces ?? []).filter((id) => id !== baseWorkspace)]
      : [];
  const lines: string[] = [
    'version: 1',
    'project:',
    `  name: ${projectName}`,
  ];

  if (mode === 'workspace') {
    lines.push(
      'workspaces:',
      `  default: ${baseWorkspace}`,
      '  global:',
      '    enabled: false',
      '    allowWrite: false',
      '  items:',
      `    ${baseWorkspace}: {}`,
    );

    for (const workspaceId of workspaceIds) {
      if (workspaceId === baseWorkspace) {
        continue;
      }

      lines.push(`    ${workspaceId}:`, '      extends: [base]');
    }
  }

  lines.push(
    'profiles:',
    '  default: local',
    'envMapping:',
    '  convention: SCREAMING_SNAKE',
    'public:',
    '  promote: []',
    '',
  );

  return lines.join('\n');
}

export async function ensureFile(filePath: string, content: string): Promise<boolean> {
  try {
    await readFile(filePath, 'utf8');
    return false;
  } catch {
    await writeFile(filePath, content, 'utf8');
    return true;
  }
}

export async function ensureGitignore(root: string): Promise<boolean> {
  const gitignorePath = path.join(root, '.gitignore');
  const requiredEntries = [
    '.cnos/env/.env',
    '.cnos/env/.env.*',
    '!.cnos/env/.env.example',
    '!.cnos/env/.env.*.example',
    '.cnos/workspaces/*/env/.env',
    '.cnos/workspaces/*/env/.env.*',
    '!.cnos/workspaces/*/env/.env.example',
    '!.cnos/workspaces/*/env/.env.*.example',
  ];

  let current = '';

  try {
    current = await readFile(gitignorePath, 'utf8');
  } catch {
    current = '';
  }

  const missingEntries = requiredEntries.filter((entry) => !current.includes(entry));

  if (missingEntries.length === 0) {
    return false;
  }

  const prefix = current.trim().length > 0 ? `${current.trimEnd()}\n` : '';
  await writeFile(gitignorePath, `${prefix}${missingEntries.join('\n')}\n`, 'utf8');
  return true;
}

export async function ensureWorkspaceLayout(
  cnosRoot: string,
  workspace?: string,
): Promise<string[]> {
  const workspaceRoot = workspace ? path.join(cnosRoot, 'workspaces', workspace) : cnosRoot;
  const createdPaths: string[] = [];

  await mkdir(path.join(workspaceRoot, 'profiles'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'values'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'secrets'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'env'), { recursive: true });

  const relativePaths = workspace
    ? [
        ['workspaces', workspace, 'profiles', '.gitkeep'],
        ['workspaces', workspace, 'values', '.gitkeep'],
        ['workspaces', workspace, 'secrets', '.gitkeep'],
        ['workspaces', workspace, 'env', '.gitkeep'],
      ]
    : [
        ['profiles', '.gitkeep'],
        ['values', '.gitkeep'],
        ['secrets', '.gitkeep'],
        ['env', '.gitkeep'],
      ];

  for (const relativePath of relativePaths) {
    const filePath = path.join(cnosRoot, ...relativePath);

    if (await ensureFile(filePath, '')) {
      createdPaths.push(path.relative(path.dirname(cnosRoot), filePath).replace(/\\/g, '/'));
    }
  }

  return createdPaths;
}

export async function ensureCnosrc(
  root: string,
  workspace?: string,
): Promise<boolean> {
  return ensureFile(
    path.join(root, '.cnosrc.yml'),
    workspace ? `root: ./.cnos\nworkspace: ${workspace}\n` : 'root: ./.cnos\n',
  );
}

export interface ScaffoldProjectOptions {
  mode?: 'regular' | 'workspace';
  workspace?: string;
  workspaces?: string[];
}

export async function scaffoldProject(
  root: string,
  options: ScaffoldProjectOptions = {},
): Promise<ScaffoldWorkspaceResult> {
  const mode = options.mode ?? 'regular';
  const baseWorkspace = options.workspace ?? 'base';
  const childWorkspaces =
    mode === 'workspace'
      ? (options.workspaces ?? []).filter((workspaceId) => workspaceId !== baseWorkspace)
      : [];
  const cnosRoot = path.join(root, '.cnos');
  const createdPaths: string[] = [];

  if (mode === 'workspace') {
    createdPaths.push(
      ...(await ensureWorkspaceLayout(cnosRoot, baseWorkspace)).map((entry) => entry.replace(/^\.cnos\//, '.cnos/')),
    );

    for (const workspaceId of childWorkspaces) {
      createdPaths.push(
        ...(await ensureWorkspaceLayout(cnosRoot, workspaceId)).map((entry) => entry.replace(/^\.cnos\//, '.cnos/')),
      );
    }
  } else {
    createdPaths.push(...(await ensureWorkspaceLayout(cnosRoot)).map((entry) => entry.replace(/^\.cnos\//, '.cnos/')));
  }

  if (
    await ensureFile(path.join(cnosRoot, 'cnos.yml'), scaffoldManifest(path.basename(root), options))
  ) {
    createdPaths.push('.cnos/cnos.yml');
  }

  if (await ensureCnosrc(root, mode === 'workspace' ? baseWorkspace : undefined)) {
    createdPaths.push('.cnosrc.yml');
  }

  if (
    mode === 'workspace' &&
    (await ensureFile(path.join(root, '.cnos-workspace.yml'), `workspace: ${baseWorkspace}\nglobalRoot: ~/.cnos\n`))
  ) {
    createdPaths.push('.cnos-workspace.yml');
  }

  if (await ensureGitignore(root)) {
    createdPaths.push('.gitignore');
  }

  return {
    root,
    mode,
    ...(mode === 'workspace' ? { workspace: baseWorkspace, workspaces: [baseWorkspace, ...childWorkspaces] } : {}),
    created: createdPaths,
  };
}
