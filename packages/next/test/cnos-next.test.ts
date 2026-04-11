import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCnosNextEnv, withCnosNext } from '../src/index.js';

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-next-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'values'), { recursive: true });
  await mkdir(path.join(root, '.cnos', 'profiles', 'stage', 'values'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: next-fixture',
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

describe('@kitsy/cnos-next', () => {
  it('loads CNOS public env for Next', async () => {
    const root = await createFixtureRoot();

    await expect(loadCnosNextEnv({ root })).resolves.toEqual({
      NEXT_PUBLIC_APP_API_URL: 'https://api.local',
    });
  });

  it('maps Next phase to a CNOS profile and merges env plus browser data into returned config', async () => {
    const root = await createFixtureRoot();
    const nextConfig = withCnosNext(
      {
        reactStrictMode: true,
        env: {
          NEXT_PUBLIC_APP_NAME: 'demo',
        },
      },
      {
        root,
        profileFromPhase(phase) {
          return phase === 'phase-development-server' ? undefined : 'stage';
        },
      },
    );

    const resolved = await nextConfig('phase-production-build', {
      defaultConfig: {},
    });

    expect(resolved).toEqual({
      reactStrictMode: true,
      env: {
        NEXT_PUBLIC_APP_NAME: 'demo',
        NEXT_PUBLIC_APP_API_URL: 'https://api.stage',
      },
      compiler: {
        define: {
          'globalThis.__CNOS_BROWSER_DATA__': JSON.stringify({
            'public.app.apiUrl': 'https://api.stage',
          }),
        },
      },
    });
  });
});
