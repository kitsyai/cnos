import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCnosVitePlugin, loadCnosViteEnv } from '../src/index.js';

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-vite-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'values'), { recursive: true });
  await mkdir(path.join(root, '.cnos', 'profiles', 'stage', 'values'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: vite-fixture',
      'public:',
      '  promote:',
      '    - value.app.apiUrl',
      'envMapping:',
      '  convention: SCREAMING_SNAKE',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'values', 'app.yml'),
    ['app:', '  apiUrl: https://api.local'].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'profiles', 'stage', 'values', 'app.yml'),
    ['app:', '  apiUrl: https://api.stage'].join('\n'),
  );
  return root;
}

describe('@kitsy/cnos-vite', () => {
  it('loads CNOS public env for Vite', async () => {
    const root = await createFixtureRoot();

    await expect(loadCnosViteEnv({ root })).resolves.toEqual({
      VITE_APP_API_URL: 'https://api.local',
    });
  });

  it('maps Vite mode to a CNOS profile and injects define replacements', async () => {
    const root = await createFixtureRoot();
    const plugin = createCnosVitePlugin({
      root,
      profileFromMode(mode) {
        return mode === 'stage' ? 'stage' : undefined;
      },
    });

    expect(plugin.config).toBeTypeOf('function');
    const config = await plugin.config!(
      {
        define: {
          __EXISTING__: 'true',
        },
        envPrefix: 'APP_',
      },
      {
        command: 'build',
        mode: 'stage',
      },
    );

    expect(config).toEqual({
      define: {
        __EXISTING__: 'true',
        'globalThis.__CNOS_BROWSER_DATA__': JSON.stringify(
          JSON.stringify({
            'public.app.apiUrl': 'https://api.stage',
          }),
        ),
        'import.meta.env.VITE_APP_API_URL': JSON.stringify('https://api.stage'),
        'process.env.__CNOS_BROWSER_DATA__': JSON.stringify(
          JSON.stringify({
            'public.app.apiUrl': 'https://api.stage',
          }),
        ),
        'process.env.VITE_APP_API_URL': JSON.stringify('https://api.stage'),
      },
      envPrefix: ['APP_', 'VITE_'],
    });
  });
});
