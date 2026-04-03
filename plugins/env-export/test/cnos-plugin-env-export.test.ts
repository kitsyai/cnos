import { describe, expect, it } from 'vitest';

import { createEnvExportPlugin, createPublicEnvExportPlugin, toPublicEnv } from '../src/index.js';

describe('@kitsy/cnos-plugin-env-export', () => {
  it('creates the expected exporter ids', () => {
    expect(createEnvExportPlugin().id).toBe('env');
    expect(createPublicEnvExportPlugin().id).toBe('public-env');
  });

  it('filters secret values from public env output', () => {
    expect(
      toPublicEnv([
        { key: 'value.app.name', value: 'cnos', namespace: 'value', sourceId: 'fixture', pluginId: 'fixture' },
        {
          key: 'secret.app.token',
          value: 'secret',
          namespace: 'secret',
          sourceId: 'fixture',
          pluginId: 'fixture',
        },
      ]),
    ).toBe('VALUE_APP_NAME=cnos');
  });
});
