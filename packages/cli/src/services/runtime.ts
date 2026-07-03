import { createCnos } from '@kitsy/cnos/configure';

export interface RuntimeServiceOptions {
  cwd?: string;
  root?: string;
  workspace?: string;
  profile?: string;
  globalRoot?: string;
  cacheMode?: 'runtime' | 'build' | 'dev';
  cacheTtlSeconds?: number;
  forceRefresh?: boolean;
  json?: boolean;
  verbose?: boolean;
  usePrivate?: boolean;
  writePrivate?: boolean;
  target?: 'local' | 'global';
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
  secretResolution?: 'eager' | 'lazy' | 'refreshing';
  secretRefreshTtl?: number;
}

export async function createRuntimeService(options: RuntimeServiceOptions = {}) {
  return createCnos({
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.root ? { root: options.root } : {}),
    ...(options.workspace ? { workspace: options.workspace } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.globalRoot ? { globalRoot: options.globalRoot } : {}),
    cacheMode: options.cacheMode ?? 'runtime',
    ...(typeof options.cacheTtlSeconds === 'number' ? { cacheTtlSeconds: options.cacheTtlSeconds } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
    ...(options.cliArgs && options.cliArgs.length > 0 ? { cliArgs: options.cliArgs } : {}),
    ...(options.usePrivate ? { usePrivate: true } : {}),
    ...(options.secretResolution ? { secretResolution: options.secretResolution } : {}),
    ...(typeof options.secretRefreshTtl === 'number' ? { secretRefreshTtl: options.secretRefreshTtl } : {}),
    processEnv: options.processEnv ?? process.env,
  });
}
