import { describe, expect, it } from 'vitest';

import { createDotenvPlugin } from '../src/index.js';

describe('@kitsy/cnos-plugin-dotenv', () => {
  it('creates a named plugin', () => {
    expect(createDotenvPlugin().id).toBe('dotenv');
  });
});
