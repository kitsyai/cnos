import { describe, expect, it } from 'vitest';

import { createProcessEnvPlugin, processEnvEntriesFromObject } from '../src/index.js';

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
        pluginId: '@kitsy/cnos-plugin-process-env',
        origin: {
          envVar: 'SERVER_PORT',
        },
      },
      {
        key: 'value.inventory.db.host',
        value: 'db.internal',
        namespace: 'value',
        sourceId: 'process-env',
        pluginId: '@kitsy/cnos-plugin-process-env',
        origin: {
          envVar: 'DATABASE_HOST',
        },
      },
      {
        key: 'secret.inventory.db.password',
        value: 'top-secret',
        namespace: 'secret',
        sourceId: 'process-env',
        pluginId: '@kitsy/cnos-plugin-process-env',
        origin: {
          envVar: 'SECRET_INVENTORY_DB_PASSWORD',
        },
      },
    ]);
  });
});
