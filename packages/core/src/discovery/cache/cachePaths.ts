import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { expandHomePath } from '../../utils/path.js';

export interface RemoteRootCachePaths {
  cacheRoot: string;
  cacheDir: string;
  repoDir: string;
  metaPath: string;
}

export function resolveCnosCacheRoot(
  processEnv: Record<string, string | undefined> = process.env,
): string {
  return path.resolve(
    expandHomePath(processEnv.CNOS_CACHE_DIR ?? path.join(os.homedir(), '.cnos', 'cache')),
  );
}

export function createRemoteRootCacheKey(uri: string): string {
  return createHash('sha256').update(uri).digest('hex');
}

export function resolveRemoteRootCachePaths(
  uri: string,
  processEnv: Record<string, string | undefined> = process.env,
): RemoteRootCachePaths {
  const cacheRoot = resolveCnosCacheRoot(processEnv);
  const cacheDir = path.join(cacheRoot, 'roots', createRemoteRootCacheKey(uri));

  return {
    cacheRoot,
    cacheDir,
    repoDir: path.join(cacheDir, 'repo'),
    metaPath: path.join(cacheDir, '.cnos-cache-meta.json'),
  };
}
