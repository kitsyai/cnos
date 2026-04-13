import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

import { CnosDiscoveryError } from '../errors.js';
import type { ResolvedRoot } from '../types/manifest.js';
import { parseGitUri, type ParsedGitUri } from './parseGitUri.js';
import {
  isImmutableGitRef,
  isRemoteRootCacheFresh,
  type RemoteRootCacheMode,
} from './cache/cacheManager.js';
import {
  readRemoteRootCacheMetadata,
  writeRemoteRootCacheMetadata,
} from './cache/cacheMetadata.js';
import { resolveRemoteRootCachePaths } from './cache/cachePaths.js';

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function expandHomePath(targetPath: string): string {
  if (targetPath === '~') {
    return os.homedir();
  }

  if (targetPath.startsWith('~/') || targetPath.startsWith('~\\')) {
    return path.join(os.homedir(), targetPath.slice(2));
  }

  return targetPath;
}

function isLocalRootUri(rootUri: string): boolean {
  return !isGitRootUri(rootUri) && !isCnosHostedRootUri(rootUri);
}

function isCnosHostedRootUri(rootUri: string): boolean {
  return rootUri.startsWith('cnos://');
}

function isGitRootUri(rootUri: string): boolean {
  return rootUri.startsWith('git+');
}

async function runGitCommand(
  args: string[],
  options: {
    cwd?: string;
    processEnv?: Record<string, string | undefined>;
  } = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: options.processEnv ?? process.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      reject(
        new CnosDiscoveryError(
          `Failed to run git. Make sure git is installed and available on PATH. ${error.message}`,
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      const details = stderr.trim() || stdout.trim();
      reject(
        new CnosDiscoveryError(
          details
            ? `Git command failed: ${details}`
            : `Git command failed with exit code ${code ?? 1}`,
        ),
      );
    });
  });
}

async function resolveLocalRoot(
  rootUri: string,
  cnosrcDir: string,
): Promise<ResolvedRoot> {
  const candidateRoot = rootUri.startsWith('~') ? expandHomePath(rootUri) : rootUri;
  const manifestRoot = path.resolve(cnosrcDir, candidateRoot);
  const manifestPath = path.join(manifestRoot, 'cnos.yml');

  if (!(await pathExists(manifestPath))) {
    throw new CnosDiscoveryError(`.cnosrc.yml points to ${manifestRoot} but no cnos.yml found there.`);
  }

  return {
    manifestRoot,
    resolution: {
      rootUri,
      protocol: 'local',
      remote: false,
      readOnly: false,
    },
  };
}

async function ensureGitCheckout(
  parsed: ParsedGitUri,
  repoDir: string,
  processEnv: Record<string, string | undefined>,
): Promise<void> {
  const hasRepo = await pathExists(path.join(repoDir, '.git'));

  if (!hasRepo) {
    await mkdir(path.dirname(repoDir), { recursive: true });
    await runGitCommand(['clone', '--no-checkout', parsed.cloneUrl, repoDir], { processEnv });
  } else {
    await runGitCommand(['-C', repoDir, 'remote', 'set-url', 'origin', parsed.cloneUrl], {
      processEnv,
    });
  }

  await runGitCommand(['-C', repoDir, 'fetch', '--tags', '--force', 'origin'], { processEnv });
  await runGitCommand(['-C', repoDir, 'checkout', '--force', parsed.ref], { processEnv });
  await runGitCommand(['-C', repoDir, 'clean', '-fdx'], { processEnv });
}

async function resolveGitRoot(
  rootUri: string,
  options: {
    processEnv?: Record<string, string | undefined>;
    cacheMode?: RemoteRootCacheMode;
    cacheTtlSeconds?: number;
    forceRefresh?: boolean;
  } = {},
): Promise<ResolvedRoot> {
  const processEnv = options.processEnv ?? process.env;
  const parsed = parseGitUri(rootUri);
  const cachePaths = resolveRemoteRootCachePaths(rootUri, processEnv);
  const metadata = await readRemoteRootCacheMetadata(cachePaths.metaPath);
  const immutable = isImmutableGitRef(parsed.ref);
  const cacheFresh = isRemoteRootCacheFresh(metadata, {
    uri: rootUri,
    ref: parsed.ref,
    ...(options.cacheMode ? { mode: options.cacheMode } : {}),
    processEnv,
    ...(typeof options.cacheTtlSeconds === 'number' ? { ttlSeconds: options.cacheTtlSeconds } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
  });

  if (!cacheFresh) {
    try {
      await ensureGitCheckout(parsed, cachePaths.repoDir, processEnv);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const authHint =
        parsed.transport === 'ssh'
          ? ' Check your SSH key and git access.'
          : ' Check the URL and your git credential helper or token setup.';
      throw new CnosDiscoveryError(`Failed to resolve remote git root ${rootUri}. ${message}${authHint}`);
    }

    const resolvedCommit = await runGitCommand(['-C', cachePaths.repoDir, 'rev-parse', 'HEAD'], {
      processEnv,
    });
    await writeRemoteRootCacheMetadata(cachePaths.metaPath, {
      uri: rootUri,
      cloneUrl: parsed.cloneUrl,
      ref: parsed.ref,
      subpath: parsed.subpath,
      resolvedCommit,
      cachedAt: new Date().toISOString(),
      isImmutable: immutable,
    });
  }

  const nextMetadata =
    metadata && cacheFresh ? metadata : await readRemoteRootCacheMetadata(cachePaths.metaPath);
  const manifestRoot = path.join(cachePaths.repoDir, parsed.subpath);

  if (!(await pathExists(path.join(manifestRoot, 'cnos.yml')))) {
    throw new CnosDiscoveryError(
      `Git root ${rootUri} resolved to ${manifestRoot} but no cnos.yml was found there. Check the :subpath segment.`,
    );
  }

  return {
    manifestRoot,
    resolution: {
      rootUri,
      protocol: 'git',
      remote: true,
      readOnly: true,
      cacheDir: cachePaths.cacheDir,
      cacheMetaPath: cachePaths.metaPath,
      ref: parsed.ref,
      subpath: parsed.subpath,
      immutable,
      ...(nextMetadata?.resolvedCommit ? { resolvedCommit: nextMetadata.resolvedCommit } : {}),
      ...(nextMetadata?.cachedAt ? { cachedAt: nextMetadata.cachedAt } : {}),
    },
  };
}

export async function resolveRootUri(
  rootUri: string,
  cnosrcDir: string,
  options: {
    processEnv?: Record<string, string | undefined>;
    cacheMode?: RemoteRootCacheMode;
    cacheTtlSeconds?: number;
    forceRefresh?: boolean;
  } = {},
): Promise<ResolvedRoot> {
  if (isLocalRootUri(rootUri)) {
    return resolveLocalRoot(rootUri, cnosrcDir);
  }

  if (isGitRootUri(rootUri)) {
    return resolveGitRoot(rootUri, options);
  }

  if (isCnosHostedRootUri(rootUri)) {
    throw new CnosDiscoveryError(
      `The cnos:// remote root protocol is reserved but not implemented yet. Use git+https:// or git+ssh:// for now.`,
    );
  }

  throw new CnosDiscoveryError(
    `Unknown root protocol: ${rootUri}. Supported root protocols are local paths, git+https://..., and git+ssh://....`,
  );
}
