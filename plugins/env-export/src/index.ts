import { toEnv, toPublicEnv, type ExporterPlugin } from '@kitsy/cnos-core';

export { toEnv } from './toEnv.js';
export { toPublicEnv } from './toPublicEnv.js';

export function createEnvExportPlugin(): ExporterPlugin {
  return {
    id: '@kitsy/cnos/plugins/env-export',
    kind: 'exporter',
    async export(graph, context) {
      return {
        pluginId: '@kitsy/cnos/plugins/env-export',
        value: toEnv(graph, context.manifest),
      };
    },
  };
}

export function createPublicEnvExportPlugin(): ExporterPlugin {
  return {
    id: '@kitsy/cnos/plugins/public-env-export',
    kind: 'exporter',
    async export(graph, context) {
      return {
        pluginId: '@kitsy/cnos/plugins/public-env-export',
        value: toPublicEnv(graph, context.manifest),
      };
    },
  };
}
