import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCnos } from '../src/createCnos.js';
import { CNOS_GRAPH_ENV_VAR, serializeRuntimeGraph } from '../src/runtime/bootstrap.js';

const fixtureRoots: string[] = [];
const originalCwd = process.cwd();

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-singleton-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'values'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    ['version: 1', 'project:', '  name: runtime-fixture', 'envMapping:', '  explicit:', '    PORT: value.server.port'].join(
      '\n',
    ),
  );
  await writeFile(path.join(root, '.cnos', 'values', 'app.yml'), ['server:', '  port: 3000'].join('\n'));
  return root;
}

beforeEach(() => {
  delete process.env[CNOS_GRAPH_ENV_VAR];
});

afterEach(async () => {
  process.chdir(originalCwd);
  delete process.env[CNOS_GRAPH_ENV_VAR];
  vi.resetModules();
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('@kitsy/cnos root runtime entry', () => {
  it('reads synchronously when bootstrapped from __CNOS_GRAPH__', async () => {
    const root = await createFixtureRoot();
    const runtime = await createCnos({
      root,
      processEnv: {},
    });

    process.env[CNOS_GRAPH_ENV_VAR] = serializeRuntimeGraph(runtime.graph);
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    expect(cnos('value.server.port')).toBe(3000);
    expect(cnos.value('server.port')).toBe(3000);
    expect(cnos.meta('profile')).toBe('base');
  });

  it('throws a clear error before ready() when no bootstrap payload exists', async () => {
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    expect(() => cnos.read('value.server.port')).toThrow(
      'CNOS not initialized. Call await cnos.ready() or use cnos run.',
    );
  });

  it('resolves standalone mode through ready()', async () => {
    const root = await createFixtureRoot();
    process.chdir(root);
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cnos.ready();

    expect(cnos.require('value.server.port')).toBe(3000);
    expect(cnos.value('server.port')).toBe(3000);
    expect(cnos.inspect('value.server.port').value).toBe(3000);
    expect(cnos.toNamespace('value')).toMatchObject({
      server: {
        port: 3000,
      },
    });
    expect(cnos.toEnv()).toEqual({
      PORT: '3000',
    });
    expect(cnos.format('Starting server at ${value.server.port}')).toBe('Starting server at 3000');
    expect(cnos.log('Starting server at ${value.server.port}')).toBe('Starting server at 3000');
    expect(consoleSpy).toHaveBeenCalledWith('Starting server at 3000');

    consoleSpy.mockRestore();
  });
});
