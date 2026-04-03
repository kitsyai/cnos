import type { LoaderPlugin } from '@kitsy/cnos-core';

export function createProcessEnvPlugin(): LoaderPlugin {
  return {
    id: 'process-env',
    kind: 'loader',
    async load() {
      return [];
    },
  };
}
