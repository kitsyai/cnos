import { normalizeManifest } from '../manifest/normalizeManifest.js';
import { createRuntime } from './runtime.js';
import { runPipeline } from './pipeline.js';
import type { CnosCreateOptions, CnosRuntime } from '../types/core.js';

export async function createCnos(options: CnosCreateOptions = {}): Promise<CnosRuntime> {
  const manifest = normalizeManifest(
    options.manifest ?? {
      name: 'cnos-app',
    },
  );
  const plugins = options.plugins ?? [];
  const pipelineEntries = await runPipeline(plugins);
  const entries = [...(options.entries ?? []), ...pipelineEntries];
  const runtime = createRuntime(manifest, entries);

  runtime.plugins.push(...plugins);

  await Promise.all(plugins.map(async (plugin) => plugin.extendRuntime?.(runtime)));

  return runtime;
}
