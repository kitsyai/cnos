import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCnos, flattenObject, loadManifest, type ConfigEntry, type LoaderPlugin } from '../src/index.js';

const fixtureRoots: string[] = [];

async function createFixtureRoot(manifestSource: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-core-'));
  const cnosRoot = path.join(root, 'cnos');
  await mkdir(cnosRoot, { recursive: true });
  await writeFile(path.join(cnosRoot, 'cnos.yml'), manifestSource);
  fixtureRoots.push(root);
  return root;
}

function createFixtureLoader(id: string, entries: ConfigEntry[]): LoaderPlugin {
  return {
    id,
    kind: 'loader',
    async load() {
      return entries;
    },
  };
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('@kitsy/cnos-core', () => {
  it('loads and normalizes a manifest from cnos/cnos.yml', async () => {
    const root = await createFixtureRoot('version: 1\nproject:\n  name: fixture\n');
    const loadedManifest = await loadManifest({ root });

    expect(loadedManifest.manifest.project.name).toBe('fixture');
    expect(loadedManifest.manifest.profiles.default).toBe('local');
    expect(loadedManifest.manifest.plugins.resolver).toBe('profile-aware');
  });

  it('rejects invalid manifests with a clear error', async () => {
    const root = await createFixtureRoot('version: 1\nproject: {}\n');

    await expect(loadManifest({ root })).rejects.toThrow('project.name');
  });

  it('creates a runtime with flat precedence, read helpers, and meta keys', async () => {
    const root = await createFixtureRoot(
      ['version: 1', 'project:', '  name: fixture', 'resolution:', '  precedence:', '    - seed-base', '    - seed-override'].join('\n'),
    );
    const baseLoader = createFixtureLoader('seed-base', [
      {
        key: 'value.app.config',
        value: {
          host: '127.0.0.1',
          port: 3000,
        },
        namespace: 'value',
        sourceId: 'seed-base',
        pluginId: 'seed-base',
      },
    ]);
    const overrideLoader = createFixtureLoader('seed-override', [
      {
        key: 'value.app.config',
        value: {
          port: 8080,
        },
        namespace: 'value',
        sourceId: 'seed-override',
        pluginId: 'seed-override',
      },
    ]);
    const runtime = await createCnos({
      root,
      plugins: [baseLoader, overrideLoader],
    });

    expect(runtime.read('value.app.config')).toEqual({
      host: '127.0.0.1',
      port: 8080,
    });
    expect(runtime.readOr('value.app.missing', 'fallback')).toBe('fallback');
    expect(() => runtime.require('value.app.missing')).toThrow('value.app.missing');
    expect(runtime.meta('profile')).toBe('local');
    expect(runtime.meta('resolved.from')).toBe('manifest-default');
    expect(runtime.meta('cnos.version')).toBeTruthy();
    expect(runtime.inspect('value.app.config').winner.sourceId).toBe('seed-override');
    expect(runtime.toNamespace('meta')).toMatchObject({
      profile: 'local',
      resolved: {
        from: 'manifest-default',
      },
    });
  });

  it('flattens nested records', () => {
    expect(flattenObject({ app: { port: 3000 } })).toEqual({
      'app.port': 3000,
    });
  });
});
