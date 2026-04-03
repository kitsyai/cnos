import type { CnosConfigEntry } from '@kitsy/cnos-core';

import { toConfigKey } from './helpers.js';

export function filesystemValuesReader(filePath: string, value: unknown): CnosConfigEntry {
  return {
    key: toConfigKey(filePath),
    value,
    source: 'filesystem',
  };
}
