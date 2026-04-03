import type { CnosPlugin } from '@kitsy/cnos-core';

export function createBasicSchemaPlugin(): CnosPlugin {
  return {
    name: '@kitsy/cnos-plugin-basic-schema',
  };
}
