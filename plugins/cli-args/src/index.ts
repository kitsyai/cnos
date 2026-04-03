import type { LoaderPlugin } from '@kitsy/cnos-core';

export function createCliArgsPlugin(): LoaderPlugin {
  return {
    id: 'cli-args',
    kind: 'loader',
    async load() {
      return [];
    },
  };
}
