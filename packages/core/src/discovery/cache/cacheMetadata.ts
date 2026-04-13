import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface RemoteRootCacheMetadata {
  uri: string;
  cloneUrl: string;
  ref: string;
  subpath: string;
  resolvedCommit: string;
  cachedAt: string;
  isImmutable: boolean;
}

export async function readRemoteRootCacheMetadata(
  metaPath: string,
): Promise<RemoteRootCacheMetadata | undefined> {
  try {
    const source = await readFile(metaPath, 'utf8');
    const parsed = JSON.parse(source) as Partial<RemoteRootCacheMetadata>;

    if (
      !parsed ||
      typeof parsed.uri !== 'string' ||
      typeof parsed.cloneUrl !== 'string' ||
      typeof parsed.ref !== 'string' ||
      typeof parsed.subpath !== 'string' ||
      typeof parsed.resolvedCommit !== 'string' ||
      typeof parsed.cachedAt !== 'string' ||
      typeof parsed.isImmutable !== 'boolean'
    ) {
      return undefined;
    }

    return parsed as RemoteRootCacheMetadata;
  } catch {
    return undefined;
  }
}

export async function writeRemoteRootCacheMetadata(
  metaPath: string,
  metadata: RemoteRootCacheMetadata,
): Promise<void> {
  await mkdir(path.dirname(metaPath), { recursive: true });
  await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}
