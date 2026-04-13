import { loadManifest } from '@kitsy/cnos/internal';

import type { RuntimeServiceOptions } from './runtime.js';

export async function assertWritableConfigRoot(
  action: string,
  options: RuntimeServiceOptions = {},
): Promise<void> {
  const loadedManifest = await loadManifest({
    ...(options.root ? { root: options.root } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
    ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
    ...(typeof options.cacheTtlSeconds === 'number' ? { cacheTtlSeconds: options.cacheTtlSeconds } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
  });

  if (!loadedManifest.rootResolution.readOnly) {
    return;
  }

  throw new Error(
    `Cannot ${action} because the active CNOS root is remote and read-only (${loadedManifest.rootResolution.rootUri}). Clone the config repo and edit it directly.`,
  );
}
