import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  loadManifest,
  parseGitUri,
  readRemoteRootCacheMetadata,
  resolveCnosCacheRoot,
  resolveRemoteRootCachePaths,
  resolveRootUri,
} from '@kitsy/cnos/internal';

import type { RuntimeServiceOptions } from './runtime.js';

export interface CachedRootRecord {
  uri: string;
  cacheDir: string;
  cachedAt: string;
  resolvedCommit: string;
  immutable: boolean;
  ref: string;
  subpath: string;
  sizeBytes: number;
}

async function computeDirectorySize(targetPath: string): Promise<number> {
  try {
    const info = await stat(targetPath);

    if (!info.isDirectory()) {
      return info.size;
    }

    const entries = await readdir(targetPath, { withFileTypes: true });
    const sizes = await Promise.all(
      entries.map((entry) => computeDirectorySize(path.join(targetPath, entry.name))),
    );
    return sizes.reduce((sum, value) => sum + value, 0);
  } catch {
    return 0;
  }
}

export async function listCachedRoots(
  processEnv: Record<string, string | undefined> = process.env,
): Promise<CachedRootRecord[]> {
  const rootsDir = path.join(resolveCnosCacheRoot(processEnv), 'roots');

  try {
    const entries = await readdir(rootsDir, { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const cacheDir = path.join(rootsDir, entry.name);
          const metadata = await readRemoteRootCacheMetadata(path.join(cacheDir, '.cnos-cache-meta.json'));

          if (!metadata) {
            return undefined;
          }

          return {
            uri: metadata.uri,
            cacheDir,
            cachedAt: metadata.cachedAt,
            resolvedCommit: metadata.resolvedCommit,
            immutable: metadata.isImmutable,
            ref: metadata.ref,
            subpath: metadata.subpath,
            sizeBytes: await computeDirectorySize(cacheDir),
          } satisfies CachedRootRecord;
        }),
    );

    return records
      .filter((record): record is CachedRootRecord => Boolean(record))
      .sort((left, right) => left.uri.localeCompare(right.uri));
  } catch {
    return [];
  }
}

export async function clearCachedRoots(
  uri: string | undefined,
  processEnv: Record<string, string | undefined> = process.env,
): Promise<{ cleared: string[] }> {
  if (uri) {
    const paths = resolveRemoteRootCachePaths(uri, processEnv);
    await rm(paths.cacheDir, { recursive: true, force: true });
    return { cleared: [uri] };
  }

  const records = await listCachedRoots(processEnv);
  await Promise.all(records.map((record) => rm(record.cacheDir, { recursive: true, force: true })));
  return {
    cleared: records.map((record) => record.uri),
  };
}

export async function refreshCachedRoots(
  uri: string | undefined,
  options: RuntimeServiceOptions = {},
): Promise<{ refreshed: string[] }> {
  const processEnv = options.processEnv ?? process.env;

  if (uri) {
    const parsed = parseGitUri(uri);
    await resolveRootUri(uri, process.cwd(), {
      processEnv,
      cacheMode: 'build',
      forceRefresh: true,
    });
    return { refreshed: [parsed.uri] };
  }

  const loadedManifest = await loadManifest({
    ...(options.root ? { root: options.root } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    processEnv,
  }).catch(() => undefined);

  if (loadedManifest?.rootResolution.remote && loadedManifest.rootResolution.protocol === 'git') {
    await resolveRootUri(loadedManifest.rootResolution.rootUri, loadedManifest.consumerRoot, {
      processEnv,
      cacheMode: 'build',
      forceRefresh: true,
    });
    return {
      refreshed: [loadedManifest.rootResolution.rootUri],
    };
  }

  const records = await listCachedRoots(processEnv);
  const mutable = records.filter((record) => !record.immutable);

  for (const record of mutable) {
    await resolveRootUri(record.uri, process.cwd(), {
      processEnv,
      cacheMode: 'build',
      forceRefresh: true,
    });
  }

  return {
    refreshed: mutable.map((record) => record.uri),
  };
}
