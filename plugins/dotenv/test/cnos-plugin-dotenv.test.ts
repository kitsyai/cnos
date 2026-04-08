import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDotenvPlugin, dotenvEntriesFromObject, parseDotenv } from '../src/index.js';

const fixtureRoots: string[] = [];

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-dotenv-'));
  fixtureRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('@kitsy/cnos-plugin-dotenv', () => {
  it('creates a named plugin', () => {
    expect(createDotenvPlugin().id).toBe('dotenv');
  });

  it('parses dotenv documents and ignores comments', () => {
    expect(
      parseDotenv([
        '# comment',
        'SERVER_PORT=3000',
        'export SECRET_API_KEY="s3cr3t"',
        "APP_NAME='cnos'",
        'IGNORED',
      ].join('\n')),
    ).toEqual({
      SERVER_PORT: '3000',
      SECRET_API_KEY: 's3cr3t',
      APP_NAME: 'cnos',
    });
  });

  it('maps dotenv variables into logical config entries', () => {
    expect(
      dotenvEntriesFromObject(
        {
          SERVER_PORT: '3000',
          DATABASE_HOST: 'db.internal',
          SECRET_INVENTORY_DB_PASSWORD: 'top-secret',
          ignored: 'nope',
        },
        {
          convention: 'SCREAMING_SNAKE',
          explicit: {
            DATABASE_HOST: 'value.inventory.db.host',
          },
        },
        'cnos/env/.env.local',
      ),
    ).toEqual([
      {
        key: 'value.server.port',
        value: '3000',
        namespace: 'value',
        sourceId: 'dotenv',
        pluginId: '@kitsy/cnos/plugins/dotenv',
        workspaceId: 'default',
        origin: {
          envVar: 'SERVER_PORT',
          file: 'cnos/env/.env.local',
        },
      },
      {
        key: 'value.inventory.db.host',
        value: 'db.internal',
        namespace: 'value',
        sourceId: 'dotenv',
        pluginId: '@kitsy/cnos/plugins/dotenv',
        workspaceId: 'default',
        origin: {
          envVar: 'DATABASE_HOST',
          file: 'cnos/env/.env.local',
        },
      },
      {
        key: 'secret.inventory.db.password',
        value: 'top-secret',
        namespace: 'secret',
        sourceId: 'dotenv',
        pluginId: '@kitsy/cnos/plugins/dotenv',
        workspaceId: 'default',
        origin: {
          envVar: 'SECRET_INVENTORY_DB_PASSWORD',
          file: 'cnos/env/.env.local',
        },
      },
    ]);
  });

  it('loads base and profile dotenv files in order', async () => {
    const root = await createFixtureRoot();
    const cnosRoot = path.join(root, 'cnos');
    const envRoot = path.join(cnosRoot, 'env');
    await mkdir(envRoot, { recursive: true });
    await writeFile(path.join(envRoot, '.env'), 'SERVER_PORT=3000\n');
    await writeFile(path.join(envRoot, '.env.local'), 'SERVER_PORT=8080\nDATABASE_HOST=localhost\n');

    const plugin = createDotenvPlugin();
    const entries = await plugin.load({
      manifest: {} as never,
      manifestConfig: {
        root: './env',
        envMapping: {
          convention: 'SCREAMING_SNAKE',
          explicit: {
            DATABASE_HOST: 'value.inventory.db.host',
          },
        },
      },
      profile: 'local',
      profileChain: ['local'],
      profileActivation: {
        values: ['base', 'local'],
        secrets: ['local'],
        envFiles: ['.env', '.env.local'],
      },
      manifestRoot: cnosRoot,
      workspace: {
        workspaceId: 'fixture',
        workspaceSource: 'implicit',
        workspaceChain: ['fixture'],
        workspaceRoots: [
          {
            scope: 'local',
            workspaceId: 'fixture',
            path: cnosRoot,
          },
        ],
      },
    });

    expect(entries.map((entry) => [entry.key, entry.value, entry.origin?.file])).toEqual([
      ['value.server.port', '3000', 'cnos/env/.env'],
      ['value.server.port', '8080', 'cnos/env/.env.local'],
      ['value.inventory.db.host', 'localhost', 'cnos/env/.env.local'],
    ]);
  });
});
