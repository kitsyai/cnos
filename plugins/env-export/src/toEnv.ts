import type { CnosConfigEntry } from '@kitsy/cnos-core';

export function toEnv(entries: CnosConfigEntry[]): string {
  return entries.map((entry) => `${entry.key.toUpperCase().replace(/\./g, '_')}=${entry.value ?? ''}`).join('\n');
}
