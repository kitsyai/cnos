import { describe, expect, it } from 'vitest';

import { createEnvExportPlugin, toPublicEnv } from '../src/index.js';

describe('@kitsy/cnos-plugin-env-export', () => {
  it('creates a named plugin', () => {
    expect(createEnvExportPlugin().name).toBe('@kitsy/cnos-plugin-env-export');
  });

  it('filters secret values from public env output', () => {
    expect(
      toPublicEnv([
        { key: 'app.name', value: 'cnos' },
        { key: 'app.token', value: 'secret', secret: true },
      ]),
    ).toBe('APP_NAME=cnos');
  });
});
