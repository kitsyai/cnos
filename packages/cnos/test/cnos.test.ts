import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCnos, defaultPlugins, type LoaderPlugin } from '../src/index.js';

const fixtureRoots: string[] = [];

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-runtime-'));
  const cnosRoot = path.join(root, 'cnos');
  await mkdir(cnosRoot, { recursive: true });
  await writeFile(path.join(cnosRoot, 'cnos.yml'), 'version: 1\nproject:\n  name: cnos-runtime\n');
  fixtureRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('@kitsy/cnos', () => {
  it('wires the official plugins into the runtime', async () => {
    const root = await createFixtureRoot();
    const fixtureLoader: LoaderPlugin = {
      id: 'fixture-loader',
      kind: 'loader',
      async load() {
        return [
          {
            key: 'value.app.name',
            value: 'fixture-app',
            namespace: 'value',
            sourceId: 'fixture-loader',
            pluginId: 'fixture-loader',
          },
        ];
      },
    };
    const runtime = await createCnos({
      root,
      plugins: [fixtureLoader],
    });

    expect(runtime.plugins).toHaveLength(defaultPlugins().length + 1);
    expect(runtime.require('value.app.name')).toBe('fixture-app');
  });
});
