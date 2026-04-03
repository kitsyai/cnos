import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CnosManifestError } from '../errors.js';
import type { LogicalKey, NamespaceName } from '../types/core.js';

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
  const candidates = [path.join(basePath, 'cnos'), basePath];

  for (const candidate of candidates) {
    if (await exists(path.join(candidate, 'cnos.yml'))) {
      return candidate;
    }
  }

  throw new CnosManifestError(`Could not locate cnos/cnos.yml from root: ${basePath}`);
}

export async function resolveManifestRoot(root = process.cwd()): Promise<string> {
  return resolveCnosRoot(root);
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
  return `${namespace}.${joinConfigPath(valuePath)}`;
}

export function stripNamespace(key: LogicalKey): string {
  return key.split('.').slice(1).join('.');
}
