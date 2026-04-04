import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ScaffoldWorkspaceResult {
  root: string;
  workspace: string;
  created: string[];
}

function scaffoldManifest(projectName: string, workspace: string): string {
  return [
    'version: 1',
    'project:',
    `  name: ${projectName}`,
    'workspaces:',
    `  default: ${workspace}`,
    '  global:',
    '    enabled: false',
    '    allowWrite: false',
    '  items:',
    `    ${workspace}: {}`,
    'profiles:',
    '  default: local',
    'envMapping:',
    '  convention: SCREAMING_SNAKE',
    'public:',
    '  promote: []',
    '',
  ].join('\n');
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
    'cnos/workspaces/*/secrets/',
    'cnos/workspaces/*/env/.env',
    'cnos/workspaces/*/env/.env.*',
    '!cnos/workspaces/*/env/.env.example',
    '!cnos/workspaces/*/env/.env.*.example',
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

export async function scaffoldWorkspace(root: string, workspace: string): Promise<ScaffoldWorkspaceResult> {
  const cnosRoot = path.join(root, 'cnos');
  const workspaceRoot = path.join(cnosRoot, 'workspaces', workspace);
  const createdPaths: string[] = [];

  await mkdir(path.join(workspaceRoot, 'profiles'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'values', 'local'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'secrets', 'local'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'env'), { recursive: true });

  for (const relativePath of [
    ['workspaces', workspace, 'profiles', '.gitkeep'],
    ['workspaces', workspace, 'values', 'local', '.gitkeep'],
    ['workspaces', workspace, 'secrets', 'local', '.gitkeep'],
    ['workspaces', workspace, 'env', '.gitkeep'],
  ]) {
    const filePath = path.join(cnosRoot, ...relativePath);

    if (await ensureFile(filePath, '')) {
      createdPaths.push(path.relative(root, filePath).replace(/\\/g, '/'));
    }
  }

  if (await ensureFile(path.join(cnosRoot, 'cnos.yml'), scaffoldManifest(path.basename(root), workspace))) {
    createdPaths.push('cnos/cnos.yml');
  }

  if (await ensureFile(path.join(root, '.cnos-workspace.yml'), `workspace: ${workspace}\nglobalRoot: ~/.cnos\n`)) {
    createdPaths.push('.cnos-workspace.yml');
  }

  if (await ensureGitignore(root)) {
    createdPaths.push('.gitignore');
  }

  return {
    root,
    workspace,
    created: createdPaths,
  };
}
