import { describe, expect, it } from 'vitest';

import { createProcessEnvPlugin, processEnvEntriesFromObject, processNamespaceEntriesFromContext } from '../src/index.js';

describe('@kitsy/cnos-plugin-process-env', () => {
  it('creates a named plugin', () => {
    expect(createProcessEnvPlugin().id).toBe('process-env');
  });

  it('maps process env entries with convention and explicit overrides', () => {
    expect(
      processEnvEntriesFromObject(
        {
          SERVER_PORT: '8080',
          DATABASE_HOST: 'db.internal',
          SECRET_INVENTORY_DB_PASSWORD: 'top-secret',
          UNUSED_VALUE: undefined,
        },
        {
          convention: 'SCREAMING_SNAKE',
          explicit: {
            DATABASE_HOST: 'value.inventory.db.host',
          },
        },
      ),
    ).toEqual([
      {
        key: 'value.server.port',
        value: '8080',
        namespace: 'value',
        sourceId: 'process-env',
        pluginId: '@kitsy/cnos/plugins/process-env',
        workspaceId: 'default',
        origin: {
          envVar: 'SERVER_PORT',
        },
      },
      {
        key: 'value.inventory.db.host',
        value: 'db.internal',
        namespace: 'value',
        sourceId: 'process-env',
        pluginId: '@kitsy/cnos/plugins/process-env',
        workspaceId: 'default',
        origin: {
          envVar: 'DATABASE_HOST',
        },
      },
      {
        key: 'secret.inventory.db.password',
        value: 'top-secret',
        namespace: 'secret',
        sourceId: 'process-env',
        pluginId: '@kitsy/cnos/plugins/process-env',
        workspaceId: 'default',
        origin: {
          envVar: 'SECRET_INVENTORY_DB_PASSWORD',
        },
      },
    ]);
  });

  it('emits server-only process namespace entries', () => {
    const entries = processNamespaceEntriesFromContext(
      {
        PATH: 'C:/tools',
        APPDATA: 'C:/Users/test/AppData/Roaming',
        __CNOS_GRAPH__: 'omit-me',
      },
      'fixture',
    );

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'process.env.PATH',
          value: 'C:/tools',
          namespace: 'process',
        }),
        expect.objectContaining({
          key: 'process.cwd',
          namespace: 'process',
        }),
        expect.objectContaining({
          key: 'process.node.version',
          namespace: 'process',
        }),
      ]),
    );
    expect(entries.some((entry) => entry.key === 'process.env.__CNOS_GRAPH__')).toBe(false);
  });
});
