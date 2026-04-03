import { describe, expect, it } from 'vitest';

import { createCnos, flattenObject } from '../src/index.js';

describe('@kitsy/cnos-core', () => {
  it('creates a runtime with seeded entries', async () => {
    const runtime = await createCnos({
      entries: [
        {
          key: 'app.port',
          value: 3000,
        },
      ],
      manifest: {
        name: 'fixture',
      },
    });

    expect(runtime.read('app.port')).toBe(3000);
  });

  it('flattens nested records', () => {
    expect(flattenObject({ app: { port: 3000 } })).toEqual({
      'app.port': 3000,
    });
  });
});
