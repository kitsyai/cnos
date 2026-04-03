import type { ConfigEntry } from '@kitsy/cnos-core';

import { toConfigKey } from './helpers.js';

export function filesystemValuesReader(filePath: string, value: unknown): ConfigEntry {
  return {
    key: `value.${toConfigKey(filePath)}`,
    value,
    namespace: 'value',
    sourceId: 'filesystem-values',
    pluginId: '@kitsy/cnos-plugin-filesystem',
    origin: {
      file: filePath,
    },
  };
}
