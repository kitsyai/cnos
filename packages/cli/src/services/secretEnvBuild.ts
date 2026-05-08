import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';

import type { CnosRuntime } from '@kitsy/cnos';

export interface SecretEnvMapping {
  envVar: string;
  logicalKey: string;
}

function isInteractiveSession(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY && !process.env.CI;
}

export function getSecretEnvMappings(runtime: CnosRuntime): SecretEnvMapping[] {
  return Object.entries(runtime.manifest.envMapping.explicit)
    .filter(([, logicalKey]) => runtime.graph.entries.get(logicalKey)?.namespace === 'secret')
    .map(([envVar, logicalKey]) => ({
      envVar,
      logicalKey,
    }))
    .sort((left, right) => left.envVar.localeCompare(right.envVar));
}

function resolveGitRoot(cwd: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    return undefined;
  }

  const value = result.stdout.trim();
  return value ? path.resolve(value) : undefined;
}

function isGitIgnored(repoRoot: string, targetPath: string): boolean {
  const relativeTarget = path.relative(repoRoot, targetPath);

  if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    return false;
  }

  const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', relativeTarget], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  return result.status === 0;
}

export async function assertSecretEnvTargetIsGitIgnored(targetPath: string, cwd: string): Promise<void> {
  const repoRoot = resolveGitRoot(cwd);

  if (!repoRoot) {
    throw new Error(
      `Cannot write revealed secrets to ${targetPath} because CNOS could not verify gitignore protection. Run inside a git repo or omit --reveal.`,
    );
  }

  const gitignorePath = path.join(repoRoot, '.gitignore');

  try {
    await readFile(gitignorePath, 'utf8');
  } catch {
    throw new Error(
      `Cannot write revealed secrets to ${targetPath} because ${gitignorePath} is missing. Add a gitignored env target or omit --reveal.`,
    );
  }

  if (!isGitIgnored(repoRoot, targetPath)) {
    const relativeTarget = path.relative(repoRoot, targetPath).replace(/\\/g, '/');
    throw new Error(
      `Cannot write revealed secrets to ${targetPath} because ${relativeTarget} is not gitignored. Add an ignore rule first, then re-run cnos build env --reveal.`,
    );
  }
}

export async function confirmSecretEnvBuild(targetPath: string, mappings: SecretEnvMapping[]): Promise<void> {
  if (!isInteractiveSession()) {
    return;
  }

  console.error(`!WARN CNOS is about to write resolved secret values into ${targetPath}.`);
  console.error(
    `!WARN Secret env vars: ${mappings.map((mapping) => mapping.envVar).join(', ')}`,
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await rl.question('Continue writing secrets to this env artifact? [y/N] ')).trim().toLowerCase();

    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Aborted secret env build.');
    }
  } finally {
    rl.close();
  }
}
