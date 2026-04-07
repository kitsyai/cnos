import { createCnos, resolveBrowserData, type CnosCreateOptions } from '@kitsy/cnos';

export interface ViteConfigEnv {
  command: 'serve' | 'build';
  mode: string;
}

export interface ViteUserConfigLike {
  define?: Record<string, string>;
  envPrefix?: string | string[];
}

export interface VitePluginLike {
  name: string;
  enforce?: 'pre' | 'post';
  config?: (
    config: ViteUserConfigLike,
    env: ViteConfigEnv,
  ) => Promise<ViteUserConfigLike> | ViteUserConfigLike;
}

export interface CnosVitePluginOptions extends CnosCreateOptions {
  prefix?: string;
  includeProcessEnvShim?: boolean;
  profileFromMode?: (mode: string, env: ViteConfigEnv) => string | undefined;
}

function resolveRuntimeOptions(
  options: CnosVitePluginOptions,
  env: ViteConfigEnv,
): CnosCreateOptions {
  const profile =
    options.profile ??
    options.profileFromMode?.(env.mode, env);

  return {
    ...options,
    ...(profile ? { profile } : {}),
  };
}

function mergeEnvPrefix(existing: string | string[] | undefined, nextPrefix: string): string[] {
  const prefixes = Array.isArray(existing) ? existing : existing ? [existing] : [];
  const merged = new Set([...prefixes, nextPrefix]);
  return [...merged];
}

export async function loadCnosViteEnv(
  options: CnosVitePluginOptions = {},
  env: ViteConfigEnv = {
    command: 'build',
    mode: 'production',
  },
): Promise<Record<string, string>> {
  const runtime = await createCnos(resolveRuntimeOptions(options, env));

  return runtime.toPublicEnv({
    framework: 'vite',
    ...(options.prefix ? { prefix: options.prefix } : {}),
  });
}

export function createCnosVitePlugin(
  options: CnosVitePluginOptions = {},
): VitePluginLike {
  return {
    name: 'cnos-vite',
    enforce: 'pre',
    async config(config, env) {
      const [publicEnv, browserData] = await Promise.all([
        loadCnosViteEnv(options, env),
        resolveBrowserData(resolveRuntimeOptions(options, env)),
      ]);
      const defineEntries = Object.fromEntries(
        Object.entries(publicEnv).flatMap(([key, value]) => {
          const entries: Array<[string, string]> = [[`import.meta.env.${key}`, JSON.stringify(value)]];

          if (options.includeProcessEnvShim ?? true) {
            entries.push([`process.env.${key}`, JSON.stringify(value)]);
          }

          return entries;
        }),
      );

      const prefix = options.prefix ?? 'VITE_';

      return {
        define: {
          ...(config.define ?? {}),
          'globalThis.__CNOS_BROWSER_DATA__': JSON.stringify(JSON.stringify(browserData)),
          'process.env.__CNOS_BROWSER_DATA__': JSON.stringify(JSON.stringify(browserData)),
          ...defineEntries,
        },
        envPrefix: mergeEnvPrefix(config.envPrefix, prefix),
      };
    },
  };
}
