import type { CnosPlugin } from '@kitsy/cnos-core';

export { toEnv } from './toEnv.js';
export { toPublicEnv } from './toPublicEnv.js';

export function createEnvExportPlugin(): CnosPlugin {
  return {
    name: '@kitsy/cnos-plugin-env-export',
  };
}
