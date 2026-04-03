import { access } from 'node:fs/promises';
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
