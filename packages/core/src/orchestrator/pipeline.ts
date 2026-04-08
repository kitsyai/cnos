import type { ConfigEntry } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';
import type { ProfileActivation } from '../types/profile.js';
import type { LoaderPlugin } from '../types/plugin.js';
import type { WorkspaceContext } from '../types/workspace.js';

export interface PipelineOptions {
  manifestRoot: string;
  manifest: NormalizedManifest;
  profile: string;
  profileChain: string[];
  profileActivation: ProfileActivation;
  workspace: WorkspaceContext;
  plugins: LoaderPlugin[];
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
}

export async function runPipeline(options: PipelineOptions): Promise<ConfigEntry[]> {
  const collectedEntries = await Promise.all(
    options.plugins.map((plugin) =>
      plugin.load({
        manifest: options.manifest,
        manifestConfig: {
          ...(options.manifest.sources[plugin.id] ?? {}),
          envMapping: options.manifest.envMapping,
        },
        profile: options.profile,
        profileChain: options.profileChain,
        profileActivation: options.profileActivation,
        manifestRoot: options.manifestRoot,
        workspace: options.workspace,
        ...(options.cliArgs ? { cliArgs: options.cliArgs } : {}),
        ...(options.processEnv ? { processEnv: options.processEnv } : {}),
      }),
    ),
  );

  return collectedEntries.flat();
}
