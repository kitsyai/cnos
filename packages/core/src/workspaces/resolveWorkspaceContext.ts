import { access } from 'node:fs/promises';
import path from 'node:path';

import { CnosManifestError } from '../errors.js';
import type { NormalizedManifest } from '../types/manifest.js';
import type { GlobalRootSource, WorkspaceContext, WorkspaceFile, WorkspaceSource } from '../types/workspace.js';
import { expandHomePath } from '../utils/path.js';
import { expandWorkspaceChain } from './expandWorkspaceChain.js';

export interface ResolveWorkspaceContextOptions {
  manifestRoot: string;
  workspaceFile?: WorkspaceFile;
  anchoredWorkspace?: string;
  workspace?: string;
  globalRoot?: string;
  processEnv?: Record<string, string | undefined>;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveLocalWorkspaceRoot(
  manifestRoot: string,
  workspaceId: string,
  manifest: NormalizedManifest,
): Promise<string> {
  const workspaceRoot = path.join(manifestRoot, 'workspaces', workspaceId);

  if (await exists(workspaceRoot)) {
    return workspaceRoot;
  }

  const customDataNamespaceRoots = Object.entries(manifest.namespaces)
    .filter(
      ([namespace, definition]) =>
        namespace !== 'value' &&
        namespace !== 'secret' &&
        definition.kind === 'data' &&
        !definition.sensitive,
    )
    .map(([namespace]) => namespace);
  const legacyMarkers = ['values', 'secrets', 'env', 'profiles', ...customDataNamespaceRoots].map((segment) =>
    path.join(manifestRoot, segment),
  );

  if ((await Promise.all(legacyMarkers.map((marker) => exists(marker)))).some(Boolean)) {
    return manifestRoot;
  }

  return workspaceRoot;
}

function resolveWorkspaceSelection(
  manifest: NormalizedManifest,
  workspaceFile: WorkspaceFile | undefined,
  anchoredWorkspace: string | undefined,
  workspaceOption: string | undefined,
): { workspaceId: string; source: WorkspaceSource } {
  if (workspaceOption) {
    return {
      workspaceId: workspaceOption,
      source: 'cli',
    };
  }

  if (workspaceFile?.workspace) {
    return {
      workspaceId: workspaceFile.workspace,
      source: 'workspace-file',
    };
  }

  if (anchoredWorkspace) {
    return {
      workspaceId: anchoredWorkspace,
      source: 'anchor-file',
    };
  }

  if (manifest.workspaces.default) {
    return {
      workspaceId: manifest.workspaces.default,
      source: 'manifest-default',
    };
  }

  if (Object.keys(manifest.workspaces.items).length === 0) {
    return {
      workspaceId: 'default',
      source: 'implicit',
    };
  }

  throw new CnosManifestError(
    'Workspace selection requires --workspace, .cnos-workspace.yml, or workspaces.default when workspaces.items are defined',
  );
}

function resolveGlobalRoot(
  manifest: NormalizedManifest,
  workspaceFile: WorkspaceFile | undefined,
  options: ResolveWorkspaceContextOptions,
): { value?: string; source?: GlobalRootSource } {
  if (!manifest.workspaces.global.enabled) {
    return {};
  }

  if (options.globalRoot) {
    return {
      value: path.resolve(expandHomePath(options.globalRoot)),
      source: 'cli',
    };
  }

  if (workspaceFile?.globalRoot) {
    return {
      value: path.resolve(expandHomePath(workspaceFile.globalRoot)),
      source: 'workspace-file',
    };
  }

  if (manifest.workspaces.global.root) {
    return {
      value: path.resolve(expandHomePath(manifest.workspaces.global.root)),
      source: 'manifest',
    };
  }

  const cnosHome = options.processEnv?.CNOS_HOME;

  if (cnosHome) {
    return {
      value: path.resolve(expandHomePath(cnosHome)),
      source: 'CNOS_HOME',
    };
  }

  return {};
}

export async function resolveWorkspaceContext(
  manifest: NormalizedManifest,
  options: ResolveWorkspaceContextOptions,
): Promise<WorkspaceContext> {
  const selectedWorkspace = resolveWorkspaceSelection(
    manifest,
    options.workspaceFile,
    options.anchoredWorkspace,
    options.workspace,
  );
  const workspaceChain = expandWorkspaceChain(selectedWorkspace.workspaceId, manifest.workspaces.items);
  const globalRoot = resolveGlobalRoot(manifest, options.workspaceFile, options);
  const workspaceRoots: WorkspaceContext['workspaceRoots'] = [];

  if (globalRoot.value) {
    for (const chainWorkspaceId of workspaceChain) {
      const globalWorkspaceId =
        manifest.workspaces.items[chainWorkspaceId]?.globalId ?? chainWorkspaceId;

      workspaceRoots.push({
        scope: 'global',
        workspaceId: chainWorkspaceId,
        path: path.join(globalRoot.value, 'workspaces', globalWorkspaceId),
      });
    }
  }

  for (const chainWorkspaceId of workspaceChain) {
    workspaceRoots.push({
      scope: 'local',
      workspaceId: chainWorkspaceId,
      path: await resolveLocalWorkspaceRoot(options.manifestRoot, chainWorkspaceId, manifest),
    });
  }

  return {
    workspaceId: selectedWorkspace.workspaceId,
    workspaceSource: selectedWorkspace.source,
    ...(globalRoot.value ? { globalRoot: globalRoot.value } : {}),
    ...(globalRoot.source ? { globalRootSource: globalRoot.source } : {}),
    workspaceChain,
    workspaceRoots,
  };
}
