import { loadManifest } from '../manifest/loadManifest.js';
import { loadWorkspaceFile } from '../manifest/loadWorkspaceFile.js';
import { expandProfileChain } from '../profiles/expandProfileChain.js';
import { promoteToPublic } from '../promotions/promoteToPublic.js';
import { ensureProjectionAllowed } from '../promotions/validatePromotion.js';
import { resolveActiveProfile } from '../profiles/resolveActiveProfile.js';
import { createProfileAwareResolver } from '../resolvers/profileAwareResolver.js';
import type { CnosCreateOptions, CnosRuntime, ResolvedEntry, ResolvedGraph } from '../types/core.js';
import type { ConfigEntry } from '../types/core.js';
import type { LoaderPlugin, ResolverPlugin } from '../types/plugin.js';
import { resolveWorkspaceContext } from '../workspaces/resolveWorkspaceContext.js';
import { applySchemaRules } from '../validation/basicSchema.js';
import { runPipeline } from './pipeline.js';
import { createRuntime } from './runtime.js';

function buildMetaEntries(graph: ResolvedGraph, cnosVersion?: string): ConfigEntry[] {
  return [
    {
      key: 'meta.profile',
      value: graph.profile,
      namespace: 'meta',
      sourceId: 'profile-resolver',
      pluginId: 'core',
      workspaceId: graph.workspace.workspaceId,
    },
    {
      key: 'meta.cnos.version',
      value: cnosVersion ?? '0.0.0-dev',
      namespace: 'meta',
      sourceId: 'core',
      pluginId: 'core',
      workspaceId: graph.workspace.workspaceId,
    },
    {
      key: 'meta.resolved.at',
      value: graph.resolvedAt,
      namespace: 'meta',
      sourceId: 'core',
      pluginId: 'core',
      workspaceId: graph.workspace.workspaceId,
    },
    {
      key: 'meta.resolved.from',
      value: graph.profileSource,
      namespace: 'meta',
      sourceId: 'profile-resolver',
      pluginId: 'core',
      workspaceId: graph.workspace.workspaceId,
    },
    {
      key: 'meta.workspace',
      value: graph.workspace.workspaceId,
      namespace: 'meta',
      sourceId: 'workspace-resolver',
      pluginId: 'core',
      workspaceId: graph.workspace.workspaceId,
    },
    {
      key: 'meta.workspace.source',
      value: graph.workspace.workspaceSource,
      namespace: 'meta',
      sourceId: 'workspace-resolver',
      pluginId: 'core',
      workspaceId: graph.workspace.workspaceId,
    },
    {
      key: 'meta.workspace.chain',
      value: graph.workspace.workspaceChain,
      namespace: 'meta',
      sourceId: 'workspace-resolver',
      pluginId: 'core',
      workspaceId: graph.workspace.workspaceId,
    },
    {
      key: 'meta.globalRoot',
      value: graph.workspace.globalRoot ?? null,
      namespace: 'meta',
      sourceId: 'workspace-resolver',
      pluginId: 'core',
      workspaceId: graph.workspace.workspaceId,
    },
    {
      key: 'meta.global.enabled',
      value: Boolean(graph.workspace.globalRoot),
      namespace: 'meta',
      sourceId: 'workspace-resolver',
      pluginId: 'core',
      workspaceId: graph.workspace.workspaceId,
    },
  ];
}

function appendMetaEntries(graph: ResolvedGraph, cnosVersion?: string): ResolvedGraph {
  const nextEntries = new Map(graph.entries);

  for (const entry of buildMetaEntries(graph, cnosVersion)) {
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
  for (const key of loadedManifest.manifest.public.promote) {
    ensureProjectionAllowed(loadedManifest.manifest, key, 'public');
  }
  const workspaceFile = await loadWorkspaceFile(loadedManifest.repoRoot);
  const workspace = await resolveWorkspaceContext(loadedManifest.manifest, {
    manifestRoot: loadedManifest.manifestRoot,
    ...(workspaceFile ? { workspaceFile: workspaceFile.config } : {}),
    ...(options.workspace ? { workspace: options.workspace } : {}),
    ...(options.globalRoot ? { globalRoot: options.globalRoot } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  });
  const activeProfile = resolveActiveProfile(loadedManifest.manifest, {
    ...(options.profile ? { profile: options.profile } : {}),
    ...(workspaceFile ? { workspaceFile: workspaceFile.config } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  });
  const profileChain = await expandProfileChain(activeProfile.profile, {
    manifestRoot: loadedManifest.manifestRoot,
    workspace,
  });
  const plugins = options.plugins ?? [];
  const loaderPlugins = plugins.filter((plugin): plugin is LoaderPlugin => plugin.kind === 'loader');
  const resolverPlugin =
    plugins.find((plugin): plugin is ResolverPlugin => plugin.kind === 'resolver') ??
    createProfileAwareResolver();
  const entries = await runPipeline({
    manifestRoot: loadedManifest.manifestRoot,
    manifest: loadedManifest.manifest,
    profile: activeProfile.profile,
    profileChain: profileChain.profiles,
    profileActivation: profileChain.activation,
    workspace,
    plugins: loaderPlugins,
    ...(options.cliArgs ? { cliArgs: options.cliArgs } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  });
  const graph = await resolverPlugin.resolve(entries, {
    manifest: loadedManifest.manifest,
    profile: activeProfile.profile,
    profileChain: profileChain.profiles,
    precedenceOrder: loadedManifest.manifest.resolution.precedence,
    workspace,
  });
  const schemaApplied = applySchemaRules(graph, loadedManifest.manifest.schema);
  const promotedGraph = promoteToPublic(schemaApplied.graph, loadedManifest.manifest);

  return createRuntime(
    loadedManifest.manifest,
    appendMetaEntries({
      ...promotedGraph,
      profileSource: activeProfile.source,
    }, options.cnosVersion),
    plugins,
  );
}
