import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveBrowserData, resolveFrameworkEnv, resolveServerProjection } from '@kitsy/cnos/build';
import { stringifyYaml } from '@kitsy/cnos/internal';

import { createRuntimeService, type RuntimeServiceOptions } from './runtime.js';
import { resolveFilesystemBasePath } from './paths.js';
import {
  assertSecretEnvTargetIsGitIgnored,
  confirmSecretEnvBuild,
  getSecretEnvMappings,
} from './secretEnvBuild.js';

export type ProjectionFormat = 'dotenv' | 'docker-env' | 'json' | 'shell' | 'toml' | 'yaml';

function stringifyScalar(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  return JSON.stringify(value);
}

function escapeShell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function quoteToml(value: string): string {
  return `"${escapeShell(value)}"`;
}

function formatKeyValueMap(
  values: Record<string, unknown>,
  format: ProjectionFormat,
): string {
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));

  switch (format) {
    case 'json':
      return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
    case 'yaml':
      return stringifyYaml(Object.fromEntries(entries));
    case 'shell':
      return entries.map(([key, value]) => `export ${key}="${escapeShell(stringifyScalar(value))}"`).join('\n');
    case 'toml':
      return entries.map(([key, value]) => `${key} = ${quoteToml(stringifyScalar(value))}`).join('\n');
    case 'docker-env':
    case 'dotenv':
    default:
      return entries.map(([key, value]) => `${key}=${stringifyScalar(value)}`).join('\n');
  }
}

export async function writeProjectionFile(to: string, output: string, root = process.cwd()): Promise<string> {
  const targetPath = path.resolve(root, to);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, output, 'utf8');
  return targetPath;
}

export async function buildServerProjectionArtifact(
  to: string,
  options: RuntimeServiceOptions = {},
  format: ProjectionFormat = 'json',
): Promise<{ targetPath: string; output: string }> {
  const projection = await resolveServerProjection({
    ...options,
    cacheMode: 'build',
  });
  const output =
    format === 'yaml'
      ? stringifyYaml(projection)
      : `${JSON.stringify(projection, null, 2)}\n`;
  const targetPath = await writeProjectionFile(
    to,
    output,
    resolveFilesystemBasePath(options.root, options.cwd ?? process.cwd()),
  );

  return { targetPath, output };
}

export async function buildBrowserProjectionArtifact(
  to: string,
  options: RuntimeServiceOptions = {},
  format: ProjectionFormat = 'json',
): Promise<{ targetPath: string; output: string }> {
  const projection = await resolveBrowserData({
    ...options,
    cacheMode: 'build',
  });
  const output =
    format === 'yaml'
      ? stringifyYaml(projection)
      : `${JSON.stringify(projection, null, 2)}\n`;
  const targetPath = await writeProjectionFile(
    to,
    output,
    resolveFilesystemBasePath(options.root, options.cwd ?? process.cwd()),
  );

  return { targetPath, output };
}

export async function buildPublicProjectionArtifact(
  to: string,
  options: RuntimeServiceOptions = {},
  format: ProjectionFormat = 'dotenv',
): Promise<{ targetPath: string; output: string; env: Record<string, string> }> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const frameworkIndex = cliArgs.indexOf('--framework');
  const framework =
    frameworkIndex >= 0 && cliArgs[frameworkIndex + 1] ? cliArgs[frameworkIndex + 1] : 'generic';
  const env = await resolveFrameworkEnv(
    {
      ...options,
      cacheMode: 'build',
    },
    framework as Parameters<typeof resolveFrameworkEnv>[1],
  );
  const output = formatKeyValueMap(env, format);
  const targetPath = await writeProjectionFile(
    to,
    output,
    resolveFilesystemBasePath(options.root, options.cwd ?? process.cwd()),
  );
  return { targetPath, output, env };
}

export async function buildEnvProjectionArtifact(
  to: string,
  options: RuntimeServiceOptions = {},
  format: ProjectionFormat = 'dotenv',
): Promise<{ targetPath: string; output: string; env: Record<string, string> }> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const revealSecrets = cliArgs.includes('--reveal');
  const basePath = resolveFilesystemBasePath(options.root, options.cwd ?? process.cwd());
  const targetPath = path.resolve(basePath, to);
  const runtime = await createRuntimeService({
    ...options,
    cacheMode: 'build',
    cliArgs,
    secretResolution: 'lazy',
  });
  const secretMappings = getSecretEnvMappings(runtime);

  if (revealSecrets && secretMappings.length > 0) {
    await assertSecretEnvTargetIsGitIgnored(targetPath, basePath);
    await confirmSecretEnvBuild(targetPath, secretMappings);
  }

  const env = runtime.toEnv({
    includeSecrets: revealSecrets,
  });

  for (const { envVar } of secretMappings) {
    if (!revealSecrets && !(envVar in env)) {
      env[envVar] = '****';
    }
  }

  const output = formatKeyValueMap(env, format);
  const writtenTargetPath = await writeProjectionFile(to, output, basePath);
  return { targetPath: writtenTargetPath, output, env };
}
