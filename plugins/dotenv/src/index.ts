import type { CnosPlugin } from '@kitsy/cnos-core';

export function createDotenvPlugin(): CnosPlugin {
  return {
    name: '@kitsy/cnos-plugin-dotenv',
  };
}
