import type { CnosConfigEntry, CnosInspectRecord, CnosRuntime } from '../types/core.js';
import type { CnosManifest } from '../types/manifest.js';
import { inspectEntries } from '../runtime/inspect.js';
import { readValue } from '../runtime/read.js';
import { requireValue } from '../runtime/require.js';

export function createRuntime(manifest: CnosManifest, entries: CnosConfigEntry[] = []): CnosRuntime {
  return {
    manifest,
    plugins: [],
    read(key) {
      return readValue(entries, key);
    },
    require(key) {
      return requireValue(entries, key);
    },
    inspect(): CnosInspectRecord[] {
      return inspectEntries(entries);
    },
  };
}
