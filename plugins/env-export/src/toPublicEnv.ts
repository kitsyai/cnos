import type { ConfigEntry } from '@kitsy/cnos-core';

import { toEnv } from './toEnv.js';

export function toPublicEnv(entries: ConfigEntry[]): string {
  return toEnv(entries.filter((entry) => entry.namespace !== 'secret'));
}
