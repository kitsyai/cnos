import { readFile, realpath } from 'node:fs/promises';
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

function printSecretEnvBuildWarnings(targetPath: string, mappings: SecretEnvMapping[]): void {
  console.error(`!WARN CNOS detected explicit secret env mappings for ${targetPath}.`);
  console.error(`!WARN Writing revealed env artifacts is a security risk and may leak plaintext secrets outside CNOS.`);
  console.error(`!WARN Secret env vars: ${mappings.map((mapping) => mapping.envVar).join(', ')}`);
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

export async function hydrateSecretEnvMappings(runtime: CnosRuntime, mappings: SecretEnvMapping[]): Promise<void> {
  for (const mapping of mappings) {
    await runtime.refreshSecret(mapping.logicalKey);
  }
}

export function applyMaskedSecretEnvMappings(
  env: Record<string, string>,
  mappings: SecretEnvMapping[],
): Record<string, string> {
  const nextEnv = { ...env };

  for (const { envVar } of mappings) {
    if (!(envVar in nextEnv)) {
      nextEnv[envVar] = '****';
    }
  }

  return nextEnv;
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

async function resolveCanonicalRepoRoot(cwd: string): Promise<string | undefined> {
  const repoRoot = resolveGitRoot(cwd);

  if (!repoRoot) {
    return undefined;
  }

  try {
    return await realpath(repoRoot);
  } catch {
    return path.resolve(repoRoot);
  }
}

async function resolveCanonicalTargetPath(targetPath: string): Promise<string> {
  const resolvedPath = path.resolve(targetPath);

  try {
    const resolvedDir = await realpath(path.dirname(resolvedPath));
    return path.join(resolvedDir, path.basename(resolvedPath));
  } catch {
    return resolvedPath;
  }
}

export async function assertSecretEnvTargetIsGitIgnored(targetPath: string, cwd: string): Promise<void> {
  const repoRoot = await resolveCanonicalRepoRoot(cwd);

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

  const canonicalTargetPath = await resolveCanonicalTargetPath(targetPath);

  if (!isGitIgnored(repoRoot, canonicalTargetPath)) {
    const relativeTarget = path.relative(repoRoot, canonicalTargetPath).replace(/\\/g, '/');
    throw new Error(
      `Cannot write revealed secrets to ${targetPath} because ${relativeTarget} is not gitignored. Add an ignore rule first, then re-run cnos build env --reveal.`,
    );
  }
}

export async function confirmSecretEnvBuild(targetPath: string, mappings: SecretEnvMapping[]): Promise<void> {
  printSecretEnvBuildWarnings(targetPath, mappings);

  if (!isInteractiveSession()) {
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await rl.question('Do you want to continue? [y/N] ')).trim().toLowerCase();

    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Aborted secret env build.');
    }
  } finally {
    rl.close();
  }
}
