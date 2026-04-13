import type { RuntimeProvider } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';

export function createDefaultRuntimeProviders(
  manifest: NormalizedManifest,
  processEnv: Record<string, string | undefined>,
): Map<string, RuntimeProvider> {
  const providers = new Map<string, RuntimeProvider>();

  if (manifest.runtimeNamespaces.process) {
    providers.set('process', (key: string) => {
      const segments = key.split('.');

      if (segments[0] === 'env') {
        return processEnv[segments.slice(1).join('.')];
      }

      if (key === 'cwd') {
        return process.cwd();
      }

      if (key === 'platform') {
        return process.platform;
      }

      if (key === 'arch') {
        return process.arch;
      }

      if (key === 'pid') {
        return process.pid;
      }

      if (key === 'node.version') {
        return process.version;
      }

      return undefined;
    });
  }

  return providers;
}
