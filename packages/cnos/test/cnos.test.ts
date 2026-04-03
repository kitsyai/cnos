import { describe, expect, it } from 'vitest';

import { createCnos, defaultPlugins } from '../src/index.js';

describe('@kitsy/cnos', () => {
  it('wires the official plugins into the runtime', async () => {
    const runtime = await createCnos({
      manifest: {
        name: 'fixture',
      },
    });

    expect(runtime.plugins).toHaveLength(defaultPlugins().length);
  });
});
