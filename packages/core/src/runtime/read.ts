import type { CnosConfigEntry } from '../types/core.js';

export function readValue(entries: CnosConfigEntry[], key: string): unknown {
  return entries.find((entry) => entry.key === key)?.value;
}
