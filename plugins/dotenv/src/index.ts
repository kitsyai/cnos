import type { LoaderPlugin } from '@kitsy/cnos-core';

export function createDotenvPlugin(): LoaderPlugin {
  return {
    id: 'dotenv',
    kind: 'loader',
    async load() {
      return [];
    },
  };
}
