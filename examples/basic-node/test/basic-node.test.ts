import { describe, expect, it } from 'vitest';

import { runBasicNodeExample } from '../src/index.js';

describe('basic-node example', () => {
  it('returns seeded values', async () => {
    await expect(runBasicNodeExample()).resolves.toEqual({
      name: 'basic-node',
      port: 3000,
    });
  });
});
