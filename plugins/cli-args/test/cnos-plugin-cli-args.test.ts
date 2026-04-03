import { describe, expect, it } from 'vitest';

import { createCliArgsPlugin } from '../src/index.js';

describe('@kitsy/cnos-plugin-cli-args', () => {
  it('creates a named plugin', () => {
    expect(createCliArgsPlugin().name).toBe('@kitsy/cnos-plugin-cli-args');
  });
});
