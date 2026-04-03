import type { ExporterPlugin } from '@kitsy/cnos-core';

export { toEnv } from './toEnv.js';
export { toPublicEnv } from './toPublicEnv.js';

export function createEnvExportPlugin(): ExporterPlugin {
  return {
    id: 'env',
    kind: 'exporter',
    async export() {
      return {
        pluginId: 'env',
        value: {},
      };
    },
  };
}

export function createPublicEnvExportPlugin(): ExporterPlugin {
  return {
    id: 'public-env',
    kind: 'exporter',
    async export() {
      return {
        pluginId: 'public-env',
        value: {},
      };
    },
  };
}
