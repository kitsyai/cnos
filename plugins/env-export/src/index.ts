import { toEnv, toPublicEnv, type ExporterPlugin } from '@kitsy/cnos-core';

export { toEnv } from './toEnv.js';
export { toPublicEnv } from './toPublicEnv.js';

export function createEnvExportPlugin(): ExporterPlugin {
  return {
    id: 'env',
    kind: 'exporter',
    async export(graph, context) {
      return {
        pluginId: 'env',
        value: toEnv(graph, context.manifest),
      };
    },
  };
}

export function createPublicEnvExportPlugin(): ExporterPlugin {
  return {
    id: 'public-env',
    kind: 'exporter',
    async export(graph, context) {
      return {
        pluginId: 'public-env',
        value: toPublicEnv(graph, context.manifest),
      };
    },
  };
}
