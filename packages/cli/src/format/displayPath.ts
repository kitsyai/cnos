import path from 'node:path';

export function displayPath(filePath: string, root = process.cwd()): string {
  const absoluteRoot = path.resolve(root);
  const absoluteFile = path.resolve(filePath);
  const relative = path.relative(absoluteRoot, absoluteFile);

  if (!relative || relative === '') {
    return '.';
  }

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return absoluteFile;
  }

  return relative;
}
