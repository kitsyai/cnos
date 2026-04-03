import type { CnosConfigEntry, CnosInspectRecord } from '../types/core.js';

export function inspectEntries(entries: CnosConfigEntry[]): CnosInspectRecord[] {
  return entries.map((entry) => ({
    ...entry,
    resolved: entry.value !== undefined,
  }));
}
