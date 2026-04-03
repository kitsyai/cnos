import { applySchemaRules, type ValidatorPlugin } from '@kitsy/cnos-core';

export function createBasicSchemaPlugin(): ValidatorPlugin {
  return {
    id: 'basic-schema',
    kind: 'validator',
    async validate(graph, context) {
      const result = applySchemaRules(graph, context.schema ?? {});

      return {
        pluginId: 'basic-schema',
        valid: result.issues.length === 0,
        issues: result.issues,
      };
    },
  };
}
