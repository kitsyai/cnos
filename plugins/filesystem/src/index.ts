import type { CnosPlugin } from '@kitsy/cnos-core';

export { filesystemSecretsReader } from './filesystemSecretsReader.js';
export { filesystemValuesReader } from './filesystemValuesReader.js';
export { toConfigKey } from './helpers.js';

export function createFilesystemPlugin(): CnosPlugin {
  return {
    name: '@kitsy/cnos-plugin-filesystem',
  };
}
