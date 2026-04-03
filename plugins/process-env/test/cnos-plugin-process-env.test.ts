import { describe, expect, it } from 'vitest';

import { createProcessEnvPlugin } from '../src/index.js';

describe('@kitsy/cnos-plugin-process-env', () => {
  it('creates a named plugin', () => {
    expect(createProcessEnvPlugin().name).toBe('@kitsy/cnos-plugin-process-env');
  });
});
