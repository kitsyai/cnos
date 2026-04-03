import packageJson from '../../package.json';

import { loadManifest } from '../manifest/loadManifest.js';
import { expandProfileChain } from '../profiles/expandProfileChain.js';
import { resolveActiveProfile } from '../profiles/resolveActiveProfile.js';
import { createProfileAwareResolver } from '../resolvers/profileAwareResolver.js';
import type { CnosCreateOptions, CnosRuntime, ResolvedEntry, ResolvedGraph } from '../types/core.js';
import type { ConfigEntry } from '../types/core.js';
import type { LoaderPlugin, ResolverPlugin } from '../types/plugin.js';
import { runPipeline } from './pipeline.js';
import { createRuntime } from './runtime.js';

function buildMetaEntries(graph: ResolvedGraph): ConfigEntry[] {
  return [
    {
      key: 'meta.profile',
      value: graph.profile,
      namespace: 'meta',
      sourceId: 'profile-resolver',
      pluginId: 'core',
    },
    {
      key: 'meta.cnos.version',
      value: packageJson.version,
      namespace: 'meta',
      sourceId: 'core',
      pluginId: 'core',
    },
    {
      key: 'meta.resolved.at',
      value: graph.resolvedAt,
      namespace: 'meta',
      sourceId: 'core',
      pluginId: 'core',
    },
    {
      key: 'meta.resolved.from',
      value: graph.profileSource,
      namespace: 'meta',
      sourceId: 'profile-resolver',
      pluginId: 'core',
    },
  ];
}

function appendMetaEntries(graph: ResolvedGraph): ResolvedGraph {
  const nextEntries = new Map(graph.entries);

  for (const entry of buildMetaEntries(graph)) {
    nextEntries.set(entry.key, {
      key: entry.key,
      value: entry.value,
      namespace: entry.namespace,
      winner: entry,
      overridden: [],
    } satisfies ResolvedEntry);
  }

  return {
    ...graph,
    entries: nextEntries,
  };
}

export async function createCnos(options: CnosCreateOptions = {}): Promise<CnosRuntime> {
  const loadedManifest = await loadManifest(options.root ? { root: options.root } : {});
  const activeProfile = resolveActiveProfile(loadedManifest.manifest, {
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  });
  const profileChain = expandProfileChain(activeProfile.profile);
  const plugins = options.plugins ?? [];
  const loaderPlugins = plugins.filter((plugin): plugin is LoaderPlugin => plugin.kind === 'loader');
  const resolverPlugin =
    plugins.find((plugin): plugin is ResolverPlugin => plugin.kind === 'resolver') ??
    createProfileAwareResolver();
  const entries = await runPipeline({
    cnosRoot: loadedManifest.cnosRoot,
    manifest: loadedManifest.manifest,
    profile: activeProfile.profile,
    profileChain: profileChain.profiles,
    plugins: loaderPlugins,
    ...(options.cliArgs ? { cliArgs: options.cliArgs } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  });
  const graph = await resolverPlugin.resolve(entries, {
    manifest: loadedManifest.manifest,
    profile: activeProfile.profile,
    profileChain: profileChain.profiles,
    precedenceOrder: loadedManifest.manifest.resolution.precedence,
  });

  return createRuntime(
    loadedManifest.manifest,
    appendMetaEntries({
      ...graph,
      profileSource: activeProfile.source,
    }),
    plugins,
  );
}
