import type { ValidatorPlugin } from '@kitsy/cnos-core';

export function createBasicSchemaPlugin(): ValidatorPlugin {
  return {
    id: 'basic-schema',
    kind: 'validator',
    async validate() {
      return {
        pluginId: 'basic-schema',
        valid: true,
        issues: [],
      };
    },
  };
}
