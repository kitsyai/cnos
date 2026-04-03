import { describe, expect, it } from 'vitest';

import {
  createFilesystemSecretsPlugin,
  createFilesystemValuesPlugin,
  filesystemSecretsReader,
  filesystemValuesReader,
} from '../src/index.js';

describe('@kitsy/cnos-plugin-filesystem', () => {
  it('creates the expected loader ids', () => {
    expect(createFilesystemValuesPlugin().id).toBe('filesystem-values');
    expect(createFilesystemSecretsPlugin().id).toBe('filesystem-secrets');
  });

  it('marks secret entries explicitly', () => {
    expect(filesystemValuesReader('config/app/name', 'cnos').namespace).toBe('value');
    expect(filesystemSecretsReader('secrets/app/token', 'x').namespace).toBe('secret');
  });
});
