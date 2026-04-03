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

  it('resolves filesystem, dotenv, process env, and cli args with spec precedence', async () => {
    const root = await createFixtureRoot();
    await mkdir(path.join(root, 'cnos', 'values', 'base'), { recursive: true });
    await mkdir(path.join(root, 'cnos', 'values', 'local'), { recursive: true });
    await mkdir(path.join(root, 'cnos', 'secrets', 'local'), { recursive: true });
    await mkdir(path.join(root, 'cnos', 'env'), { recursive: true });
    await writeFile(
      path.join(root, 'cnos', 'cnos.yml'),
      [
        'version: 1',
        'project:',
        '  name: cnos-runtime',
        'envMapping:',
        '  convention: SCREAMING_SNAKE',
        '  explicit:',
        '    DATABASE_HOST: value.inventory.db.host',
        'resolution:',
        '  precedence:',
        '    - filesystem-values',
        '    - filesystem-secrets',
        '    - dotenv',
        '    - process-env',
        '    - cli-args',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'values', 'base', 'app.yml'),
      ['server:', '  port: 3000', 'inventory:', '  db:', '    host: base-db'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'values', 'local', 'app.yml'),
      ['server:', '  port: 4000'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'secrets', 'local', 'app.yml'),
      ['inventory:', '  db:', '    password: file-secret'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'env', '.env'),
      ['SERVER_PORT=5000', 'DATABASE_HOST=dotenv-db', 'SECRET_INVENTORY_DB_PASSWORD=dotenv-secret'].join('\n'),
    );

    const runtime = await createCnos({
      root,
      processEnv: {
        SERVER_PORT: '6000',
        DATABASE_HOST: 'process-db',
        SECRET_INVENTORY_DB_PASSWORD: 'process-secret',
      },
      cliArgs: ['--value.server.port=7000', '--secret.inventory.db.password=cli-secret'],
    });

    expect(runtime.require('value.server.port')).toBe('7000');
    expect(runtime.require('value.inventory.db.host')).toBe('process-db');
    expect(runtime.require('secret.inventory.db.password')).toBe('cli-secret');
    expect(runtime.inspect('value.server.port')).toMatchObject({
      profile: 'local',
      winner: {
        sourceId: 'cli-args',
        origin: {
          cliArg: '--value.server.port=7000',
        },
      },
      overridden: [
        {
          sourceId: 'filesystem-values',
          value: 3000,
        },
        {
          sourceId: 'filesystem-values',
          value: 4000,
        },
        {
          sourceId: 'dotenv',
          value: '5000',
          origin: {
            envVar: 'SERVER_PORT',
            file: 'cnos/env/.env',
          },
        },
        {
          sourceId: 'process-env',
          value: '6000',
          origin: {
            envVar: 'SERVER_PORT',
          },
        },
      ],
    });
  });
});
