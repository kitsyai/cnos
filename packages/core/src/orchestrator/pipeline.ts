import type { CnosConfigEntry } from '../types/core.js';
import type { CnosPlugin } from '../types/plugin.js';

export async function runPipeline(plugins: CnosPlugin[]): Promise<CnosConfigEntry[]> {
  const collectedEntries = await Promise.all(
    plugins.map(async (plugin) => {
      const values = await plugin.collect?.();
      return values ?? [];
    }),
  );

  return collectedEntries.flat();
}
