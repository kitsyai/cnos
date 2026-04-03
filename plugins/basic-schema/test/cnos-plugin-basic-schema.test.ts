import { describe, expect, it } from 'vitest';

import { createBasicSchemaPlugin } from '../src/index.js';

describe('@kitsy/cnos-plugin-basic-schema', () => {
  it('creates a named plugin', () => {
    expect(createBasicSchemaPlugin().id).toBe('basic-schema');
  });
});
