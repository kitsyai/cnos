import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { displayPath } from '../format/displayPath.js';
import { createRuntimeService, type RuntimeServiceOptions } from './runtime.js';

export interface MaterializedEnvResult {
  runtime: Awaited<ReturnType<typeof createRuntimeService>>;
  env: Record<string, string>;
  output: string;
}

export interface WrittenMaterializedEnvResult extends MaterializedEnvResult {
  targetPath: string;
}

function resolveEnvFromRuntime(
  runtime: Awaited<ReturnType<typeof createRuntimeService>>,
  cliArgs: string[] = [],
): Record<string, string> {
  const args = [...cliArgs];
  const isPublic = consumeFlag(args, '--public');
  const framework = consumeOption(args, '--framework');
  const prefix = consumeOption(args, '--prefix');

  return isPublic
    ? runtime.toPublicEnv({
        ...(framework ? { framework } : {}),
        ...(prefix ? { prefix } : {}),
      })
    : runtime.toEnv();
}

export function formatEnvOutput(env: Record<string, string>): string {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export async function resolveMaterializedEnv(
  options: RuntimeServiceOptions = {},
): Promise<MaterializedEnvResult> {
  const runtime = await createRuntimeService({
    ...options,
    cliArgs: [...(options.cliArgs ?? [])],
  });
  const env = resolveEnvFromRuntime(runtime, options.cliArgs ?? []);

  return {
    runtime,
    env,
    output: formatEnvOutput(env),
  };
}

export function resolveMaterializedEnvTarget(
  to: string,
  root = process.cwd(),
): string {
  return path.resolve(root, to);
}

export async function writeMaterializedEnvFile(
  to: string,
  output: string,
  root = process.cwd(),
): Promise<string> {
  const targetPath = resolveMaterializedEnvTarget(to, root);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, output, 'utf8');
  return targetPath;
}

export async function materializeEnvToFile(
  to: string,
  options: RuntimeServiceOptions = {},
): Promise<WrittenMaterializedEnvResult> {
  const result = await resolveMaterializedEnv(options);
  const targetPath = await writeMaterializedEnvFile(to, result.output, options.root ?? process.cwd());

  return {
    ...result,
    targetPath,
  };
}

export async function materializeRuntimeEnvToFile(
  runtime: Awaited<ReturnType<typeof createRuntimeService>>,
  to: string,
  options: Pick<RuntimeServiceOptions, 'root' | 'cliArgs'> = {},
): Promise<WrittenMaterializedEnvResult> {
  const env = resolveEnvFromRuntime(runtime, options.cliArgs ?? []);
  const output = formatEnvOutput(env);
  const targetPath = await writeMaterializedEnvFile(to, output, options.root ?? process.cwd());

  return {
    runtime,
    env,
    output,
    targetPath,
  };
}

export function formatMaterializedEnvWriteMessage(
  result: { env: Record<string, string>; targetPath: string },
  root = process.cwd(),
): string {
  return `Wrote ${Object.keys(result.env).length} env vars to ${displayPath(result.targetPath, root)}`;
}
