import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCnos } from '@kitsy/cnos';

import {
  collectFilesystemLayerFiles,
  createFilesystemSecretsPlugin,
  createFilesystemValuesPlugin,
  filesystemSecretsReader,
  filesystemValuesReader,
  yamlObjectToEntries,
} from '../src/index.js';

const fixtureRoots: string[] = [];

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-filesystem-'));
  fixtureRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('@kitsy/cnos-plugin-filesystem', () => {
  it('creates the expected loader ids', () => {
    expect(createFilesystemValuesPlugin().id).toBe('filesystem-values');
    expect(createFilesystemSecretsPlugin().id).toBe('filesystem-secrets');
  });

  it('flattens YAML content into namespaced logical keys', () => {
    expect(filesystemValuesReader('cnos/values/local/app.yml', 'server:\n  port: 3000\n')).toEqual([
      {
        key: 'value.server.port',
        value: 3000,
        namespace: 'value',
        sourceId: 'filesystem-values',
        pluginId: '@kitsy/cnos/plugins/filesystem',
        workspaceId: 'default',
        origin: {
          file: 'cnos/values/local/app.yml',
        },
      },
    ]);
    expect(filesystemSecretsReader('cnos/secrets/local/app.yml', 'api:\n  token: test\n')[0]?.namespace).toBe('secret');
  });

  it('collects yaml files in deterministic layer order', async () => {
    const root = await createFixtureRoot();
    await mkdir(path.join(root, 'cnos', 'values', 'base'), { recursive: true });
    await mkdir(path.join(root, 'cnos', 'values', 'local'), { recursive: true });
    await writeFile(path.join(root, 'cnos', 'values', 'local', 'b.yml'), 'x: 1\n');
    await writeFile(path.join(root, 'cnos', 'values', 'base', 'a.yml'), 'x: 1\n');

    const files = await collectFilesystemLayerFiles(
      path.join(root, 'cnos'),
      [
        {
          scope: 'local',
          workspaceId: 'fixture',
          path: path.join(root, 'cnos'),
        },
      ],
      './values',
      ['base', 'local'],
    );

    expect(files.map((file) => file.relativePath)).toEqual([
      'cnos/values/base/a.yml',
      'cnos/values/local/b.yml',
    ]);
  });

  it('throws on malformed non-object yaml documents', () => {
    expect(() => yamlObjectToEntries('- 1\n- 2\n', 'cnos/values/local/app.yml', 'value', 'filesystem-values')).toThrow(
      'YAML object document',
    );
  });

  it('integrates with the runtime and preserves base-before-local precedence', async () => {
    const root = await createFixtureRoot();
    await mkdir(path.join(root, 'cnos', 'values', 'base'), { recursive: true });
    await mkdir(path.join(root, 'cnos', 'values', 'local'), { recursive: true });
    await mkdir(path.join(root, 'cnos', 'secrets', 'local'), { recursive: true });
    await writeFile(
      path.join(root, 'cnos', 'cnos.yml'),
      ['version: 1', 'project:', '  name: filesystem-fixture', 'resolution:', '  precedence:', '    - filesystem-values', '    - filesystem-secrets'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'values', 'base', 'app.yml'),
      ['server:', '  host: 127.0.0.1', '  port: 3000'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'values', 'local', 'app.yml'),
      ['server:', '  port: 8080'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'secrets', 'local', 'app.yml'),
      ['database:', '  password: s3cr3t'].join('\n'),
    );

    const runtime = await createCnos({
      root,
      plugins: [createFilesystemValuesPlugin(), createFilesystemSecretsPlugin()],
    });

    expect(runtime.require('value.server.host')).toBe('127.0.0.1');
    expect(runtime.require('value.server.port')).toBe(8080);
    expect(runtime.require('secret.database.password')).toBe('s3cr3t');
    expect(runtime.inspect('value.server.port').winner.workspaceId).toBe('default');
    expect(runtime.inspect('value.server.port').winner.origin?.file).toBe('cnos/values/local/app.yml');
  });

  it('resolves github-secrets refs from process env during secret loading', async () => {
    const root = await createFixtureRoot();
    await mkdir(path.join(root, 'cnos', 'secrets', 'base'), { recursive: true });
    await writeFile(
      path.join(root, 'cnos', 'cnos.yml'),
      ['version: 1', 'project:', '  name: filesystem-fixture', 'vaults:', '  github-ci:', '    provider: github-secrets'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'secrets', 'base', 'app.yml'),
      ['db:', '  password:', '    provider: github-secrets', '    vault: github-ci', '    ref: DB_PASSWORD'].join('\n'),
    );

    const runtime = await createCnos({
      root,
      plugins: [createFilesystemSecretsPlugin()],
      processEnv: {
        DB_PASSWORD: 'ci-secret',
      },
    });

    expect(runtime.require('secret.db.password')).toBe('ci-secret');
  });
});
