import type { RemoteRootCacheMetadata } from './cacheMetadata.js';

export type RemoteRootCacheMode = 'runtime' | 'build' | 'dev';

const SEMVER_TAG_RE = /^v?\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

export function isImmutableGitRef(ref: string): boolean {
  return SEMVER_TAG_RE.test(ref) || COMMIT_SHA_RE.test(ref);
}

export function resolveRemoteRootCacheTtlSeconds(
  mode: RemoteRootCacheMode = 'runtime',
  processEnv: Record<string, string | undefined> = process.env,
  override?: number,
): number {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return override;
  }

  const fromEnv = Number(processEnv.CNOS_CACHE_TTL ?? '');

  if (Number.isFinite(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }

  switch (mode) {
    case 'build':
      return 0;
    case 'dev':
      return 30;
    case 'runtime':
    default:
      return 300;
  }
}

export function isRemoteRootCacheFresh(
  metadata: RemoteRootCacheMetadata | undefined,
  options: {
    uri: string;
    ref: string;
    mode?: RemoteRootCacheMode;
    processEnv?: Record<string, string | undefined>;
    ttlSeconds?: number;
    forceRefresh?: boolean;
  },
): boolean {
  if (!metadata || options.forceRefresh) {
    return false;
  }

  if (metadata.uri !== options.uri || metadata.ref !== options.ref) {
    return false;
  }

  if (metadata.isImmutable) {
    return true;
  }

  const ttlSeconds = resolveRemoteRootCacheTtlSeconds(
    options.mode,
    options.processEnv,
    options.ttlSeconds,
  );

  if (ttlSeconds <= 0) {
    return false;
  }

  const cachedAtMs = Date.parse(metadata.cachedAt);

  if (Number.isNaN(cachedAtMs)) {
    return false;
  }

  return Date.now() - cachedAtMs <= ttlSeconds * 1000;
}
