import { createCnos as createCoreCnos, createProvenanceInspector, type CnosCreateOptions } from '@kitsy/cnos-core';
import { createBasicSchemaPlugin } from '@kitsy/cnos-plugin-basic-schema';
import { createCliArgsPlugin } from '@kitsy/cnos-plugin-cli-args';
import { createDotenvPlugin } from '@kitsy/cnos-plugin-dotenv';
import {
  createEnvExportPlugin,
  createPublicEnvExportPlugin,
} from '@kitsy/cnos-plugin-env-export';
import {
  createFilesystemSecretsPlugin,
  createFilesystemValuesPlugin,
} from '@kitsy/cnos-plugin-filesystem';
import { createProcessEnvPlugin } from '@kitsy/cnos-plugin-process-env';

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

function defaultPlugins() {
  return [
    createFilesystemValuesPlugin(),
    createFilesystemSecretsPlugin(),
    createDotenvPlugin(),
    createProcessEnvPlugin(),
    createCliArgsPlugin(),
    createBasicSchemaPlugin(),
    createEnvExportPlugin(),
    createPublicEnvExportPlugin(),
    createProvenanceInspector(),
  ];
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
  const profile =
    options.profile ??
    options.profileFromMode?.(env.mode, env);
  const runtime = await createCoreCnos({
    ...options,
    plugins: [...defaultPlugins(), ...(options.plugins ?? [])],
    ...(profile ? { profile } : {}),
  });

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
      const publicEnv = await loadCnosViteEnv(options, env);
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
          ...defineEntries,
        },
        envPrefix: mergeEnvPrefix(config.envPrefix, prefix),
      };
    },
  };
}
