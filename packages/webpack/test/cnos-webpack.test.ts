import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CnosWebpackPlugin,
  loadCnosWebpackEnv,
  resolveCnosWebpackBindings,
  resolveCnosWebpackBuildConfig,
} from '../src/index.js';

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixtureRoot(options: { webpackPrefix?: string } = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-webpack-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'values'), { recursive: true });
  await mkdir(path.join(root, '.cnos', 'profiles', 'stage', 'values'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: webpack-fixture',
      'public:',
      ...(options.webpackPrefix !== undefined
        ? ['  frameworks:', `    webpack: ${options.webpackPrefix}`]
        : []),
      '  promote:',
      '    - value.app.apiUrl',
      '    - value.flags.upi_enabled',
      'namespaces:',
      '  flags:',
      '    kind: data',
      '    shareable: true',
      'envMapping:',
      '  convention: SCREAMING_SNAKE',
      'schema:',
      '  value.devServer.port:',
      '    type: number',
      '    default: 3000',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'values', 'app.yml'),
    ['app:', '  apiUrl: https://api.local', 'flags:', '  upi_enabled: true', 'devServer:', '  port: 4300'].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'profiles', 'stage', 'values', 'app.yml'),
    ['app:', '  apiUrl: https://api.stage', 'flags:', '  upi_enabled: false', 'devServer:', '  port: 5300'].join('\n'),
  );
  return root;
}

class FakeTapPromiseHook<TArgs extends unknown[] = []> {
  private readonly handlers: Array<(...args: TArgs) => Promise<void>> = [];

  tapPromise(_name: string, handler: (...args: TArgs) => Promise<void>): void {
    this.handlers.push(handler);
  }

  async trigger(...args: TArgs): Promise<void> {
    for (const handler of this.handlers) {
      await handler(...args);
    }
  }
}

class FakeDefinePlugin {
  static runtimeValue(getter: () => string): { __runtimeValue: () => string } {
    return { __runtimeValue: getter };
  }

  readonly definitions: Record<string, unknown>;

  constructor(definitions: Record<string, unknown>) {
    this.definitions = definitions;
  }

  apply(compiler: FakeCompiler): void {
    compiler.appliedDefinitions = this.definitions;
  }
}

class FakeCompiler {
  appliedDefinitions: Record<string, unknown> | undefined;

  readonly hooks = {
    beforeRun: new FakeTapPromiseHook<[FakeCompiler]>(),
    watchRun: new FakeTapPromiseHook<[FakeCompiler]>(),
  };

  readonly webpack = {
    DefinePlugin: FakeDefinePlugin,
  };
}

describe('@kitsy/cnos-webpack', () => {
  it('loads CNOS public env for webpack with framework-specific prefixes', async () => {
    const root = await createFixtureRoot({ webpackPrefix: 'APP_' });

    await expect(loadCnosWebpackEnv({ root })).resolves.toEqual({
      APP_API_URL: 'https://api.local',
      APP_FLAGS_UPI_ENABLED: 'true',
    });
  });

  it('defaults webpack public env to an empty prefix when the manifest does not configure one', async () => {
    const root = await createFixtureRoot();

    await expect(loadCnosWebpackEnv({ root })).resolves.toEqual({
      APP_API_URL: 'https://api.local',
      FLAGS_UPI_ENABLED: 'true',
    });
  });

  it('resolves build-time runtime config and browser bindings', async () => {
    const root = await createFixtureRoot({ webpackPrefix: 'APP_' });
    const config = await resolveCnosWebpackBuildConfig({
      root,
      profile: 'stage',
    });

    expect(config.runtime.read('value.devServer.port')).toBe(5300);
    expect(config.browserData).toEqual({
      'public.app.apiUrl': 'https://api.stage',
      'public.flags.upi_enabled': false,
    });
    expect(config.publicEnv).toEqual({
      APP_API_URL: 'https://api.stage',
      APP_FLAGS_UPI_ENABLED: 'false',
    });
  });

  it('injects process env definitions and browser data through DefinePlugin', async () => {
    const root = await createFixtureRoot({ webpackPrefix: 'APP_' });
    const compiler = new FakeCompiler();
    const plugin = new CnosWebpackPlugin({
      root,
      profile: 'stage',
    });

    plugin.apply(compiler);
    await compiler.hooks.beforeRun.trigger(compiler);

    const definitions = compiler.appliedDefinitions;
    expect(definitions).toBeDefined();

    expect(
      (definitions!['process.env.APP_API_URL'] as { __runtimeValue: () => string }).__runtimeValue(),
    ).toBe(JSON.stringify('https://api.stage'));
    expect(
      (definitions!['process.env.APP_FLAGS_UPI_ENABLED'] as { __runtimeValue: () => string }).__runtimeValue(),
    ).toBe(JSON.stringify('false'));
    expect(
      (definitions!['globalThis.__CNOS_BROWSER_DATA__'] as { __runtimeValue: () => string }).__runtimeValue(),
    ).toBe(
      JSON.stringify(
        JSON.stringify({
          'public.app.apiUrl': 'https://api.stage',
          'public.flags.upi_enabled': false,
        }),
      ),
    );
  });

  it('resolves raw bindings for generic bundler consumption', async () => {
    const root = await createFixtureRoot({ webpackPrefix: 'APP_' });

    await expect(resolveCnosWebpackBindings({ root })).resolves.toMatchObject({
      browserData: {
        'public.app.apiUrl': 'https://api.local',
        'public.flags.upi_enabled': true,
      },
      publicEnv: {
        APP_API_URL: 'https://api.local',
        APP_FLAGS_UPI_ENABLED: 'true',
      },
    });
  });
});
