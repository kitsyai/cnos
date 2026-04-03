import type { ConfigEntry } from '@kitsy/cnos-core';

export function toEnv(entries: ConfigEntry[]): string {
  return entries.map((entry) => `${entry.key.toUpperCase().replace(/\./g, '_')}=${entry.value ?? ''}`).join('\n');
}
