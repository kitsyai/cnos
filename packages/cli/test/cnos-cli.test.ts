import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseArgs } from '../src/cli/parseArgs.js';
import { runInit } from '../src/commands/init.js';
import { runInspect } from '../src/commands/inspect.js';
import { runRead } from '../src/commands/read.js';
import { runSecret } from '../src/commands/secret.js';
import { runValue } from '../src/commands/value.js';
import { printJson } from '../src/format/printJson.js';

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRuntimeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, 'cnos', 'workspaces', 'api', 'values', 'local'), { recursive: true });
  await mkdir(path.join(root, 'cnos', 'workspaces', 'api', 'secrets', 'local'), { recursive: true });
  await writeFile(
    path.join(root, 'cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: cli-fixture',
      'workspaces:',
      '  default: api',
      '  items:',
      '    api: {}',
      'envMapping:',
      '  convention: SCREAMING_SNAKE',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, 'cnos', 'workspaces', 'api', 'values', 'local', 'app.yml'),
    ['app:', '  name: cli-fixture', 'server:', '  port: 8080'].join('\n'),
  );
  await writeFile(
    path.join(root, 'cnos', 'workspaces', 'api', 'secrets', 'local', 'app.yml'),
    ['app:', '  token: super-secret'].join('\n'),
  );
  return root;
}

describe('@kitsy/cnos-cli', () => {
  it('parses workspace-aware global flags and preserves runtime cli args', () => {
    expect(
      parseArgs([
        'read',
        'value.app.name',
        '--workspace',
        'api',
        '--profile=stage',
        '--global-root',
        'C:/global',
        '--json',
        '--value.server.port=9000',
      ]),
    ).toEqual({
      command: 'read',
      args: ['value.app.name'],
      options: {
        workspace: 'api',
        profile: 'stage',
        globalRoot: 'C:/global',
        json: true,
        cliArgs: ['--value.server.port=9000'],
      },
    });
  });

  it('scaffolds the workspace-aware starter tree and gitignore entries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-cli-init-'));
    fixtureRoots.push(root);

    await runInit({
      root,
      workspace: 'api',
    });

    await expect(readFile(path.join(root, 'cnos', 'cnos.yml'), 'utf8')).resolves.toContain(
      'default: api',
    );
    await expect(readFile(path.join(root, '.cnos-workspace.yml'), 'utf8')).resolves.toContain(
      'workspace: api',
    );
    await expect(readFile(path.join(root, '.gitignore'), 'utf8')).resolves.toContain(
      'cnos/workspaces/*/secrets/',
    );
  });

  it('formats json output', () => {
    expect(printJson({ ok: true })).toContain('"ok": true');
  });

  it('reads value and secret aliases from the selected workspace', async () => {
    const root = await createRuntimeFixture();

    await expect(runRead('value.app.name', { root, workspace: 'api', processEnv: {} })).resolves.toBe(
      'cli-fixture',
    );
    await expect(runValue('server.port', { root, workspace: 'api', processEnv: {} })).resolves.toBe(
      '8080',
    );
    await expect(runSecret('app.token', { root, workspace: 'api', processEnv: {} })).resolves.toBe(
      'super-secret',
    );
  });

  it('prints inspect output in text and json modes', async () => {
    const root = await createRuntimeFixture();

    await expect(runInspect('value.server.port', { root, workspace: 'api', processEnv: {} })).resolves.toContain(
      'workspace: api',
    );
    await expect(
      runInspect('value.server.port', { root, workspace: 'api', processEnv: {}, json: true }),
    ).resolves.toContain('"workspace"');
  });

  it('fails clearly for missing keys', async () => {
    const root = await createRuntimeFixture();

    await expect(runRead('value.app.missing', { root, workspace: 'api', processEnv: {} })).rejects.toThrow(
      'Missing CNOS config key',
    );
    await expect(runSecret('app.missing', { root, workspace: 'api', processEnv: {} })).rejects.toThrow(
      'Missing CNOS secret path',
    );
  });
});
