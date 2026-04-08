import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCnos } from '../src/createCnos.js';
import { diffGraphs, watchFiles } from '../src/internal.js';

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWatchFixture(port = '8080'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-watch-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'workspaces', 'api', 'values'), { recursive: true });
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    ['version: 1', 'project:', '  name: watch-fixture', 'workspaces:', '  default: api', '  items:', '    api: {}'].join(
      '\n',
    ),
  );
  await writeFile(
    path.join(root, '.cnos', 'workspaces', 'api', 'values', 'app.yml'),
    ['server:', `  port: "${port}"`].join('\n'),
  );

  return root;
}

describe('@kitsy/cnos watch helpers', () => {
  it('discovers manifest and workspace watch targets', async () => {
    const root = await createWatchFixture();
    const runtime = await createCnos({ root, workspace: 'api', processEnv: {} });
    const targets = await watchFiles(runtime, root);

    expect(targets.manifestPath).toBe(path.join(root, '.cnos', 'cnos.yml'));
    expect(targets.roots).toContain(path.join(root, '.cnos', 'workspaces', 'api'));
    expect(targets.files).toContain(path.join(root, '.cnos', 'workspaces', 'api', 'values', 'app.yml'));
  });

  it('diffs resolved graphs while ignoring meta noise', async () => {
    const root = await createWatchFixture('8080');
    const previous = await createCnos({ root, workspace: 'api', processEnv: {} });
    await writeFile(
      path.join(root, '.cnos', 'workspaces', 'api', 'values', 'app.yml'),
      ['server:', '  port: "9090"'].join('\n'),
    );
    const next = await createCnos({ root, workspace: 'api', processEnv: {} });

    expect(diffGraphs(previous.graph, next.graph)).toEqual(['value.server.port']);
  });
});
