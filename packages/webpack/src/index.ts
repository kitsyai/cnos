import { resolveBrowserData, resolveFrameworkEnv, type FrameworkEnvTarget } from '@kitsy/cnos/build';
import { createCnos, type CnosCreateOptions } from '@kitsy/cnos/configure';

export interface CnosWebpackPluginOptions extends CnosCreateOptions {
  prefix?: string;
  includeProcessEnvShim?: boolean;
}

export interface CnosWebpackBindings {
  browserData: Record<string, unknown>;
  publicEnv: Record<string, string>;
  definitions: Record<string, unknown>;
}

export interface WebpackLikeDefinePluginInstance {
  apply(compiler: WebpackCompilerLike): void;
}

export interface WebpackLikeDefinePluginConstructor {
  new (definitions: Record<string, unknown>): WebpackLikeDefinePluginInstance;
  runtimeValue(getter: () => string, watched: true | string[] | { fileDependencies?: string[] }): unknown;
}

export interface TapPromiseHookLike<TArgs extends unknown[] = []> {
  tapPromise(name: string, handler: (...args: TArgs) => Promise<void>): void;
}

export interface WebpackCompilerLike {
  webpack: {
    DefinePlugin: WebpackLikeDefinePluginConstructor;
  };
  hooks: {
    beforeRun: TapPromiseHookLike<[WebpackCompilerLike]>;
    watchRun: TapPromiseHookLike<[WebpackCompilerLike]>;
  };
}

const PLUGIN_NAME = 'CnosWebpackPlugin';

export async function loadCnosWebpackEnv(
  options: CnosWebpackPluginOptions = {},
): Promise<Record<string, string>> {
  return resolveFrameworkEnv(options, 'webpack', {
    ...(options.prefix ? { prefix: options.prefix } : {}),
  });
}

export async function resolveCnosWebpackBindings(
  options: CnosWebpackPluginOptions = {},
): Promise<CnosWebpackBindings> {
  const [browserData, publicEnv] = await Promise.all([
    resolveBrowserData(options),
    loadCnosWebpackEnv(options),
  ]);

  const definitions: Record<string, unknown> = {
    'globalThis.__CNOS_BROWSER_DATA__': JSON.stringify(JSON.stringify(browserData)),
  };

  if (options.includeProcessEnvShim ?? true) {
    definitions['process.env.__CNOS_BROWSER_DATA__'] = JSON.stringify(JSON.stringify(browserData));
  }

  for (const [key, value] of Object.entries(publicEnv)) {
    definitions[`process.env.${key}`] = JSON.stringify(value);
  }

  return {
    browserData,
    publicEnv,
    definitions,
  };
}

function createDynamicDefinitions(
  DefinePlugin: WebpackLikeDefinePluginConstructor,
  state: {
    browserData: Record<string, unknown>;
    publicEnv: Record<string, string>;
  },
  keys: string[],
  options: CnosWebpackPluginOptions,
): Record<string, unknown> {
  const definitions: Record<string, unknown> = {
    'globalThis.__CNOS_BROWSER_DATA__': DefinePlugin.runtimeValue(
      () => JSON.stringify(JSON.stringify(state.browserData)),
      true,
    ),
  };

  if (options.includeProcessEnvShim ?? true) {
    definitions['process.env.__CNOS_BROWSER_DATA__'] = DefinePlugin.runtimeValue(
      () => JSON.stringify(JSON.stringify(state.browserData)),
      true,
    );
  }

  for (const key of keys) {
    definitions[`process.env.${key}`] = DefinePlugin.runtimeValue(
      () => JSON.stringify(state.publicEnv[key] ?? ''),
      true,
    );
  }

  return definitions;
}

export class CnosWebpackPlugin {
  readonly options: CnosWebpackPluginOptions;

  constructor(options: CnosWebpackPluginOptions = {}) {
    this.options = options;
  }

  apply(compiler: WebpackCompilerLike): void {
    const state = {
      browserData: {} as Record<string, unknown>,
      publicEnv: {} as Record<string, string>,
    };
    let initialized = false;
    let knownKeys = new Set<string>();

    const updateState = async (): Promise<void> => {
      const bindings = await resolveCnosWebpackBindings(this.options);
      state.browserData = bindings.browserData;
      state.publicEnv = bindings.publicEnv;

      if (initialized) {
        return;
      }

      knownKeys = new Set(Object.keys(bindings.publicEnv));
      const definitions = createDynamicDefinitions(
        compiler.webpack.DefinePlugin,
        state,
        [...knownKeys],
        this.options,
      );
      new compiler.webpack.DefinePlugin(definitions).apply(compiler);
      initialized = true;
    };

    compiler.hooks.beforeRun.tapPromise(PLUGIN_NAME, async () => {
      await updateState();
    });

    compiler.hooks.watchRun.tapPromise(PLUGIN_NAME, async () => {
      const wasInitialized = initialized;
      const previousKeys = new Set(knownKeys);
      await updateState();

      if (wasInitialized && Object.keys(state.publicEnv).some((key) => !previousKeys.has(key))) {
        process.stderr.write(
          '[cnos-webpack] New public env keys were detected during watch mode. Restart webpack to apply new define entries.\n',
        );
      }
    });
  }
}

export async function loadCnosWebpackRuntime(
  options: CnosCreateOptions = {},
) {
  return createCnos(options);
}

export async function resolveCnosWebpackBuildConfig(
  options: CnosWebpackPluginOptions = {},
): Promise<{
  runtime: Awaited<ReturnType<typeof createCnos>>;
  browserData: Record<string, unknown>;
  publicEnv: Record<string, string>;
}> {
  const [runtime, browserData, publicEnv] = await Promise.all([
    createCnos(options),
    resolveBrowserData(options),
    resolveFrameworkEnv(options, 'webpack', {
      ...(options.prefix ? { prefix: options.prefix } : {}),
    }),
  ]);

  return {
    runtime,
    browserData,
    publicEnv,
  };
}

export type { FrameworkEnvTarget };
