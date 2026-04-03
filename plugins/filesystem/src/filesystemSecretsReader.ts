import type { ConfigEntry } from '@kitsy/cnos-core';

import { toConfigKey } from './helpers.js';

export function filesystemSecretsReader(filePath: string, value: unknown): ConfigEntry {
  return {
    key: `secret.${toConfigKey(filePath)}`,
    value,
    namespace: 'secret',
    sourceId: 'filesystem-secrets',
    pluginId: '@kitsy/cnos-plugin-filesystem',
    origin: {
      file: filePath,
    },
  };
}
