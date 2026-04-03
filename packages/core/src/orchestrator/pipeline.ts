import type { ConfigEntry } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';
import type { LoaderPlugin } from '../types/plugin.js';

export interface PipelineOptions {
  cnosRoot: string;
  manifest: NormalizedManifest;
  profile: string;
  profileChain: string[];
  plugins: LoaderPlugin[];
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
}

export async function runPipeline(options: PipelineOptions): Promise<ConfigEntry[]> {
  const collectedEntries = await Promise.all(
    options.plugins.map((plugin) =>
      plugin.load({
        manifestConfig: {
          ...(options.manifest.sources[plugin.id] ?? {}),
          envMapping: options.manifest.envMapping,
        },
        profile: options.profile,
        profileChain: options.profileChain,
        cnosRoot: options.cnosRoot,
        ...(options.cliArgs ? { cliArgs: options.cliArgs } : {}),
        ...(options.processEnv ? { processEnv: options.processEnv } : {}),
      }),
    ),
  );

  return collectedEntries.flat();
}
