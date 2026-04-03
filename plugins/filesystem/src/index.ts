import type { LoaderPlugin } from '@kitsy/cnos-core';

export { filesystemSecretsReader } from './filesystemSecretsReader.js';
export { filesystemValuesReader } from './filesystemValuesReader.js';
export { toConfigKey } from './helpers.js';

export function createFilesystemValuesPlugin(): LoaderPlugin {
  return {
    id: 'filesystem-values',
    kind: 'loader',
    async load() {
      return [];
    },
  };
}

export function createFilesystemSecretsPlugin(): LoaderPlugin {
  return {
    id: 'filesystem-secrets',
    kind: 'loader',
    async load() {
      return [];
    },
  };
}
