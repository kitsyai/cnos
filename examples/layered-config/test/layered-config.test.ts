import { describe, expect, it } from 'vitest';

import { runLayeredConfigExample } from '../src/index.js';

describe('layered-config example', () => {
  it('produces public env output without secrets', async () => {
    const result = await runLayeredConfigExample();

    expect(result.publicEnv).toContain('APP_NAME=layered-config');
    expect(result.publicEnv).not.toContain('APP_SECRET=hidden');
  });
});
