import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import cnos from '../src/browser/index.js';
import { resolveBrowserData, resolveFrameworkEnv, toFrameworkEnv } from '../src/build/index.js';

const fixtureRoots: string[] = [];

afterEach(async () => {
  delete (globalThis as { __CNOS_BROWSER_DATA__?: unknown }).__CNOS_BROWSER_DATA__;
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-browser-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'values'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: browser-fixture',
      'public:',
      '  promote:',
      '    - value.app.apiUrl',
      '    - value.flag.auth.upi_enabled',
      'envMapping:',
      '  convention: SCREAMING_SNAKE',
      '  explicit:',
      '    APP_API_URL: value.app.apiUrl',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'values', 'app.yml'),
    ['app:', '  apiUrl: https://api.local', 'flag:', '  auth:', '    upi_enabled: true'].join('\n'),
  );
  return root;
}

describe('@kitsy/cnos/browser', () => {
  it('reads promoted public values and supports value.* aliases', async () => {
    const root = await createFixtureRoot();
    (globalThis as { __CNOS_BROWSER_DATA__?: unknown }).__CNOS_BROWSER_DATA__ = await resolveBrowserData({ root });

    expect(cnos('public.app.apiUrl')).toBe('https://api.local');
    expect(cnos.read('value.flag.auth.upi_enabled')).toBe(true);
    expect(cnos.toObject()).toEqual({
      'public.app.apiUrl': 'https://api.local',
      'public.flag.auth.upi_enabled': true,
    });
  });

  it('throws on secret access and missing required keys', async () => {
    (globalThis as { __CNOS_BROWSER_DATA__?: unknown }).__CNOS_BROWSER_DATA__ = {
      'public.app.apiUrl': 'https://api.local',
    };

    expect(() => cnos.read('secret.app.token')).toThrow('CNOS: secret.* keys are not available in the browser.');
    expect(() => cnos.require('public.flag.auth.upi_enabled')).toThrow(
      'CNOS: key "public.flag.auth.upi_enabled" not found in browser config.',
    );
  });
});

describe('@kitsy/cnos/build', () => {
  it('returns only public.* entries', async () => {
    const root = await createFixtureRoot();

    await expect(resolveBrowserData({ root })).resolves.toEqual({
      'public.app.apiUrl': 'https://api.local',
      'public.flag.auth.upi_enabled': true,
    });
  });

  it('maps browser data into framework env shapes', async () => {
    const root = await createFixtureRoot();
    const browserData = await resolveBrowserData({ root });

    expect(toFrameworkEnv(browserData, 'generic')).toEqual({
      APP_API_URL: 'https://api.local',
      FLAG_AUTH_UPI_ENABLED: 'true',
    });
    expect(toFrameworkEnv(browserData, 'vite')).toEqual({
      VITE_APP_API_URL: 'https://api.local',
      VITE_FLAG_AUTH_UPI_ENABLED: 'true',
    });
    await expect(resolveFrameworkEnv({ root }, 'next')).resolves.toEqual({
      NEXT_PUBLIC_APP_API_URL: 'https://api.local',
      NEXT_PUBLIC_FLAG_AUTH_UPI_ENABLED: 'true',
    });
  });
});
