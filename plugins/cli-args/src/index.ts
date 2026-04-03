import type { CnosPlugin } from '@kitsy/cnos-core';

export function createCliArgsPlugin(): CnosPlugin {
  return {
    name: '@kitsy/cnos-plugin-cli-args',
  };
}
