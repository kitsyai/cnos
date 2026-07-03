import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CnosManifestError } from '../errors.js';
import { discoverCnosAnchor } from '../discovery/findCnosrc.js';
import { resolveRootUri } from '../discovery/resolveRoot.js';
import type { LogicalKey, NamespaceName } from '../types/core.js';
import type { RootResolution } from '../types/manifest.js';

export const PRIMARY_CNOS_DIR = '.cnos';
export const LEGACY_CNOS_DIR = 'cnos';

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCnosRoot(root = process.cwd()): Promise<string> {
  const basePath = path.resolve(root);
  const candidates = [
    path.join(basePath, PRIMARY_CNOS_DIR),
    path.join(basePath, LEGACY_CNOS_DIR),
    basePath,
  ];

  for (const candidate of candidates) {
    if (await exists(path.join(candidate, 'cnos.yml'))) {
      return candidate;
    }
  }

  throw new CnosManifestError(
    `Could not locate .cnos/cnos.yml or cnos/cnos.yml from root: ${basePath}`,
  );
}

export async function resolveManifestRoot(options: {
  root?: string;
  cwd?: string;
  processEnv?: Record<string, string | undefined>;
  cacheMode?: 'runtime' | 'build' | 'dev';
  cacheTtlSeconds?: number;
  forceRefresh?: boolean;
} = {}): Promise<{
  manifestRoot: string;
  consumerRoot: string;
  rootResolution: RootResolution;
  anchorPath?: string;
  workspace?: string;
}> {
  if (options.root) {
    if (
      options.root.startsWith('git+') ||
      options.root.startsWith('cnos://')
    ) {
      const consumerRoot = path.resolve(options.cwd ?? process.cwd());
      const resolvedRoot = await resolveRootUri(options.root, consumerRoot, {
        ...(options.processEnv ? { processEnv: options.processEnv } : {}),
        ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
        ...(typeof options.cacheTtlSeconds === 'number'
          ? { cacheTtlSeconds: options.cacheTtlSeconds }
          : {}),
        ...(options.forceRefresh ? { forceRefresh: true } : {}),
      });

      return {
        manifestRoot: resolvedRoot.manifestRoot,
        consumerRoot,
        rootResolution: resolvedRoot.resolution,
      };
    }

    const manifestRoot = await resolveCnosRoot(options.root);
    const resolvedRoot = path.resolve(options.root);
    const consumerRoot =
      path.basename(manifestRoot) === PRIMARY_CNOS_DIR || path.basename(manifestRoot) === LEGACY_CNOS_DIR
        ? path.dirname(manifestRoot)
        : resolvedRoot;

    return {
      manifestRoot,
      consumerRoot,
      rootResolution: {
        rootUri: manifestRoot,
        protocol: 'local',
        remote: false,
        readOnly: false,
      },
    };
  }

  const discovered = await discoverCnosAnchor(options.cwd ?? process.cwd(), 3, {
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
    ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
    ...(typeof options.cacheTtlSeconds === 'number'
      ? { cacheTtlSeconds: options.cacheTtlSeconds }
      : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
  });
  return {
    manifestRoot: discovered.manifestRoot,
    consumerRoot: discovered.consumerRoot,
    rootResolution: discovered.rootResolution,
    anchorPath: discovered.anchorPath,
    ...(discovered.workspace ? { workspace: discovered.workspace } : {}),
  };
}

export function interpolatePathTemplate(
  template: string,
  tokens: Record<string, string>,
): string {
  return Object.entries(tokens).reduce(
    (result, [token, value]) => result.replaceAll(`{${token}}`, value),
    template,
  );
}

export function expandHomePath(targetPath: string): string {
  if (targetPath === '~') {
    return os.homedir();
  }

  if (targetPath.startsWith('~/') || targetPath.startsWith('~\\')) {
    return path.join(os.homedir(), targetPath.slice(2));
  }

  return targetPath;
}

function stripWorkspaceTemplatePrefix(template: string): string {
  const normalized = template.replace(/\\/g, '/').replace(/^\.\//, '');
  const marker = 'workspaces/{workspace}';

  if (normalized === marker) {
    return '.';
  }

  if (normalized.startsWith(`${marker}/`)) {
    return normalized.slice(marker.length + 1);
  }

  return template;
}

export function resolveWorkspaceScopedPath(
  workspaceRoot: string,
  template: string,
  tokens: Record<string, string>,
): string {
  const relativeTemplate = stripWorkspaceTemplatePrefix(template);
  const interpolated = interpolatePathTemplate(relativeTemplate, tokens);
  return path.resolve(workspaceRoot, interpolated);
}

export function resolveNamespaceDirectory(
  workspaceRoot: string,
  namespace: NamespaceName,
  profile?: string,
  isPrivate = false,
): string {
  const rootFolder =
    namespace === 'value' ? 'values' : namespace === 'secret' ? 'secrets' : namespace;

  if (isPrivate) {
    if (profile && profile !== 'base') {
      return path.resolve(workspaceRoot, '.private', 'profiles', profile, rootFolder);
    }

    return path.resolve(workspaceRoot, '.private', rootFolder);
  }

  if (profile && profile !== 'base') {
    return path.resolve(workspaceRoot, 'profiles', profile, rootFolder);
  }

  return path.resolve(workspaceRoot, rootFolder);
}

export function resolveConfigDocumentPath(
  workspaceRoot: string,
  namespace: NamespaceName,
  configPath: string,
  profile?: string,
  isPrivate = false,
): string {
  const namespaceRoot = resolveNamespaceDirectory(workspaceRoot, namespace, profile, isPrivate);
  const fileName = `${configPath.split('.').shift() ?? 'app'}.yml`;
  return path.resolve(namespaceRoot, fileName);
}

export function toPortablePath(targetPath: string): string {
  return targetPath.replace(/\\/g, '/');
}

export function joinConfigPath(...parts: string[]): string {
  return parts
    .flatMap((part) => part.split('.'))
    .map((part) => part.trim())
    .filter(Boolean)
    .join('.');
}

export function toLogicalKey(namespace: NamespaceName, valuePath: string): LogicalKey {
  // Idempotency guard: already-prefixed key passes through unchanged.
  if (valuePath.startsWith(`${namespace}.`)) return valuePath as LogicalKey;
  return `${namespace}.${joinConfigPath(valuePath)}`;
}

export function stripNamespace(key: LogicalKey): string {
  return key.split('.').slice(1).join('.');
}
