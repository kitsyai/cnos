import { describe, expect, it } from 'vitest';

import { runLayeredConfigExample } from '../src/index.js';

describe('layered-config example', () => {
  it('produces inspect output and resolution metadata', async () => {
    const result = await runLayeredConfigExample();

    expect(result.inspect.key).toBe('value.app.stage');
    expect(result.meta.profile).toBe('base');
  });
});
