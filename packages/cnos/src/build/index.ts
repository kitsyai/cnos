import { type CnosCreateOptions, type ServerProjection } from '@kitsy/cnos-core';

import { createCnos } from '../createCnos.js';

export type BrowserDataMap = Record<string, unknown>;
export type FrameworkEnvTarget = 'generic' | 'vite' | 'next' | 'webpack' | (string & {});

export async function resolveBrowserData(
  options: CnosCreateOptions = {},
): Promise<BrowserDataMap> {
  const runtime = await createCnos({
    ...options,
    cacheMode: options.cacheMode ?? 'build',
  });
  const browserData: BrowserDataMap = {};

  for (const [key] of runtime.graph.entries) {
    if (!key.startsWith('public.')) {
      continue;
    }

    const inspect = runtime.inspect(key);

    if (inspect.derived?.runtimeDependent) {
      throw new Error(
        `Cannot build browser projection: ${key} depends on runtime namespaces ${inspect.derived.runtimeNamespaces.join(', ') || 'runtime'}.`,
      );
    }

    const value = runtime.read(key);

    if (value === undefined) {

      continue;
    }

    browserData[key] = value;
  }

  return browserData;
}

function toScreamingSnakeSegment(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function toScreamingSnake(path: string): string {
  return path
    .split('.')
    .map((segment) => toScreamingSnakeSegment(segment))
    .filter(Boolean)
    .join('_');
}

function stripPublicNamespace(key: string): string {
  return key.startsWith('public.') ? key.slice('public.'.length) : key;
}

function resolveFrameworkPrefix(
  framework: FrameworkEnvTarget,
  prefix?: string,
): string {
  if (prefix !== undefined) {
    return prefix;
  }

  switch (framework) {
    case 'vite':
      return 'VITE_';
    case 'next':
      return 'NEXT_PUBLIC_';
    case 'webpack':
    case 'generic':
      return '';
    default:
      return '';
  }
}

export function toFrameworkEnv(
  browserData: BrowserDataMap,
  framework: FrameworkEnvTarget = 'generic',
  options: {
    prefix?: string;
  } = {},
): Record<string, string> {
  const resolvedPrefix = resolveFrameworkPrefix(framework, options.prefix);

  return Object.fromEntries(
    Object.entries(browserData)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        `${resolvedPrefix}${toScreamingSnake(stripPublicNamespace(key))}`,
        String(value),
      ]),
  );
}

export async function resolveFrameworkEnv(
  options: CnosCreateOptions = {},
  framework: FrameworkEnvTarget = 'generic',
  envOptions: {
    prefix?: string;
  } = {},
): Promise<Record<string, string>> {
  if (framework === 'generic') {
    const browserData = await resolveBrowserData({
      ...options,
      cacheMode: options.cacheMode ?? 'build',
    });
    return toFrameworkEnv(browserData, framework, envOptions);
  }

  const runtime = await createCnos({
    ...options,
    cacheMode: options.cacheMode ?? 'build',
  });
  return runtime.toPublicEnv({
    framework,
    ...(envOptions.prefix ? { prefix: envOptions.prefix } : {}),
  });
}

export async function resolveServerProjection(
  options: CnosCreateOptions = {},
): Promise<ServerProjection> {
  const runtime = await createCnos({
    ...options,
    cacheMode: options.cacheMode ?? 'build',
  });
  return runtime.toServerProjection();
}
