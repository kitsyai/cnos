import { resolveBrowserData } from '@kitsy/cnos/build';
import { createCnos, type CnosCreateOptions } from '@kitsy/cnos/configure';

export interface NextConfigLike {
  env?: Record<string, string>;
  compiler?: {
    define?: Record<string, string>;
    [key: string]: unknown;
  };
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

function resolveRuntimeOptions(
  options: CnosNextPluginOptions,
  phase: string,
): CnosCreateOptions {
  const profile =
    options.profile ??
    options.profileFromPhase?.(phase);

  return {
    ...options,
    ...(profile ? { profile } : {}),
  };
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
  const runtime = await createCnos(resolveRuntimeOptions(options, phase));

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
    const [baseConfig, publicEnv, browserData] = await Promise.all([
      resolveBaseConfig(config, phase, context),
      loadCnosNextEnv(options, phase),
      resolveBrowserData(resolveRuntimeOptions(options, phase)),
    ]);

    return {
      ...baseConfig,
      env: {
        ...(baseConfig.env ?? {}),
        ...publicEnv,
      },
      compiler: {
        ...(baseConfig.compiler ?? {}),
        define: {
          ...(baseConfig.compiler?.define ?? {}),
          'globalThis.__CNOS_BROWSER_DATA__': JSON.stringify(browserData),
        },
      },
    };
  };
}
