import type { CnosPlugin } from '@kitsy/cnos-core';

export function createProcessEnvPlugin(): CnosPlugin {
  return {
    name: '@kitsy/cnos-plugin-process-env',
  };
}
