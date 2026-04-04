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

export interface NextConfigLike {
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface NextConfigContextLike {
  defaultConfig?: NextConfigLike;
}

export type NextConfigFactoryLike = (
  phase: string,
  context: NextConfigContextLike,
) => Promise<NextConfigLike> | NextConfigLike;

export type NextConfigInputLike = NextConfigLike | NextConfigFactoryLike;

export interface CnosNextPluginOptions extends CnosCreateOptions {
  prefix?: string;
  profileFromPhase?: (phase: string) => string | undefined;
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

async function resolveBaseConfig(
  config: NextConfigInputLike,
  phase: string,
  context: NextConfigContextLike,
): Promise<NextConfigLike> {
  if (typeof config === 'function') {
    return config(phase, context);
  }

  return config;
}

export async function loadCnosNextEnv(
  options: CnosNextPluginOptions = {},
  phase = 'phase-production-build',
): Promise<Record<string, string>> {
  const profile =
    options.profile ??
    options.profileFromPhase?.(phase);
  const runtime = await createCoreCnos({
    ...options,
    plugins: [...defaultPlugins(), ...(options.plugins ?? [])],
    ...(profile ? { profile } : {}),
  });

  return runtime.toPublicEnv({
    framework: 'next',
    ...(options.prefix ? { prefix: options.prefix } : {}),
  });
}

export function withCnosNext(
  config: NextConfigInputLike = {},
  options: CnosNextPluginOptions = {},
): NextConfigFactoryLike {
  return async (phase, context) => {
    const [baseConfig, publicEnv] = await Promise.all([
      resolveBaseConfig(config, phase, context),
      loadCnosNextEnv(options, phase),
    ]);

    return {
      ...baseConfig,
      env: {
        ...(baseConfig.env ?? {}),
        ...publicEnv,
      },
    };
  };
}
