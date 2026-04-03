import type { CnosConfigEntry } from '@kitsy/cnos-core';

import { toEnv } from './toEnv.js';

export function toPublicEnv(entries: CnosConfigEntry[]): string {
  return toEnv(entries.filter((entry) => !entry.secret));
}
