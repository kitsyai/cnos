import { applySchemaRules, type ValidatorPlugin } from '@kitsy/cnos-core';

export function createBasicSchemaPlugin(): ValidatorPlugin {
  return {
    id: '@kitsy/cnos/plugins/basic-schema',
    kind: 'validator',
    async validate(graph, context) {
      const result = applySchemaRules(graph, context.schema ?? {});

      return {
        pluginId: '@kitsy/cnos/plugins/basic-schema',
        valid: result.issues.length === 0,
        issues: result.issues,
      };
    },
  };
}
