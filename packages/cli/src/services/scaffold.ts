import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ScaffoldWorkspaceResult {
  root: string;
  workspace?: string;
  created: string[];
}

function scaffoldManifest(projectName: string, workspace?: string): string {
  const lines = [
    'version: 1',
    'project:',
    `  name: ${projectName}`,
    'profiles:',
    '  default: base',
    'envMapping:',
    '  convention: SCREAMING_SNAKE',
    'public:',
    '  promote: []',
    '',
  ];

  if (workspace) {
    lines.splice(
      4,
      0,
      'workspaces:',
      `  default: ${workspace}`,
      '  global:',
      '    enabled: false',
      '    allowWrite: false',
      '  items:',
      `    ${workspace}: {}`,
    );
  }

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

export async function scaffoldWorkspace(
  root: string,
  workspace?: string,
): Promise<ScaffoldWorkspaceResult> {
  const cnosRoot = path.join(root, '.cnos');
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
      createdPaths.push(path.relative(root, filePath).replace(/\\/g, '/'));
    }
  }

  if (
    await ensureFile(path.join(cnosRoot, 'cnos.yml'), scaffoldManifest(path.basename(root), workspace))
  ) {
    createdPaths.push('.cnos/cnos.yml');
  }

  if (
    await ensureFile(
      path.join(root, '.cnosrc.yml'),
      workspace ? `root: ./.cnos\nworkspace: ${workspace}\n` : 'root: ./.cnos\n',
    )
  ) {
    createdPaths.push('.cnosrc.yml');
  }

  if (
    workspace &&
    (await ensureFile(path.join(root, '.cnos-workspace.yml'), `workspace: ${workspace}\nglobalRoot: ~/.cnos\n`))
  ) {
    createdPaths.push('.cnos-workspace.yml');
  }

  if (await ensureGitignore(root)) {
    createdPaths.push('.gitignore');
  }

  return {
    root,
    ...(workspace ? { workspace } : {}),
    created: createdPaths,
  };
}
