import path from 'node:path';

export function resolveFilesystemBasePath(root?: string, cwd = process.cwd()): string {
  if (!root || root.startsWith('git+') || root.startsWith('cnos://')) {
    return path.resolve(cwd);
  }

  return path.resolve(root);
}
