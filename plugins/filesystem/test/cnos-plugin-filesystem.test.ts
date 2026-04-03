import { describe, expect, it } from 'vitest';

import { createFilesystemPlugin, filesystemSecretsReader, filesystemValuesReader } from '../src/index.js';

describe('@kitsy/cnos-plugin-filesystem', () => {
  it('creates a named plugin', () => {
    expect(createFilesystemPlugin().name).toBe('@kitsy/cnos-plugin-filesystem');
  });

  it('marks secret entries explicitly', () => {
    expect(filesystemValuesReader('config/app/name', 'cnos').secret).toBeUndefined();
    expect(filesystemSecretsReader('secrets/app/token', 'x').secret).toBe(true);
  });
});
