import { describe, expect, it } from 'vitest';

import { runMonorepoAppExample } from '../src/index.js';

describe('monorepo-app example', () => {
  it('returns inspectable entries', async () => {
    await expect(runMonorepoAppExample()).resolves.toEqual({
      apps: {
        web: {
          port: 4000,
        },
      },
      workspace: {
        name: 'cnos-monorepo',
      },
    });
  });
});
