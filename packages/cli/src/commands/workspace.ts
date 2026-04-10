import { cp, mkdir, rename, rm, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadManifest, parseYaml, stringifyYaml } from '@kitsy/cnos/internal';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { displayPath } from '../format/displayPath.js';
import { printJson } from '../format/printJson.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';

interface DetachedMarker {
  detachedFrom: string;
  detachedWorkspace: string;
  detachedAt: string;
  originalCnosrc: {
    root: string;
    workspace?: string;
  };
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfExists(source: string, target: string): Promise<void> {
  if (!(await exists(source))) {
    return;
  }

  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

async function mergeWorkspaceRootsIntoStandalone(targetCnosRoot: string, sourceRoots: string[]): Promise<void> {
  for (const sourceRoot of sourceRoots) {
    for (const folderName of ['values', 'secrets', 'env', 'profiles']) {
      await copyIfExists(
        path.join(sourceRoot, folderName),
        path.join(targetCnosRoot, folderName),
      );
    }
  }
}

async function writeCnosrc(packageRoot: string, config: { root: string; workspace?: string }): Promise<void> {
  await writeFile(
    path.join(packageRoot, '.cnosrc.yml'),
    stringifyYaml({
      root: config.root,
      ...(config.workspace ? { workspace: config.workspace } : {}),
    }),
    'utf8',
  );
}

function createDetachedManifest(rawManifest: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(rawManifest);

  if ('workspaces' in next) {
    delete next.workspaces;
  }

  return next;
}

async function runDetach(
  packageRoot: string,
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const loaded = await loadManifest({ cwd: packageRoot });

  if (!loaded.anchorPath || !loaded.anchoredWorkspace) {
    throw new Error('workspace detach requires a package-local .cnosrc.yml with a workspace binding');
  }

  const targetCnosRoot = path.join(packageRoot, '.cnos');
  const force = consumeFlag([...(options.cliArgs ?? [])], '--force');

  if ((await exists(targetCnosRoot)) && !force) {
    throw new Error(`Refusing to detach because ${displayPath(targetCnosRoot, packageRoot)} already exists. Use --force to overwrite.`);
  }

  if (force) {
    await rm(targetCnosRoot, { recursive: true, force: true });
  }

  const runtime = await createRuntimeService({
    ...options,
    root: loaded.manifestRoot,
    workspace: loaded.anchoredWorkspace,
  });
  const localRoots = runtime.graph.workspace.workspaceRoots
    .filter((root) => root.scope === 'local')
    .map((root) => root.path);

  await mkdir(targetCnosRoot, { recursive: true });
  await mergeWorkspaceRootsIntoStandalone(targetCnosRoot, localRoots);
  await writeFile(
    path.join(targetCnosRoot, 'cnos.yml'),
    stringifyYaml(createDetachedManifest(loaded.rawManifest as Record<string, unknown>)),
    'utf8',
  );

  const relativeRoot = path.relative(packageRoot, loaded.manifestRoot).replace(/\\/g, '/');
  const marker: DetachedMarker = {
    detachedFrom: relativeRoot || '.',
    detachedWorkspace: loaded.anchoredWorkspace,
    detachedAt: new Date().toISOString(),
    originalCnosrc: {
      root: relativeRoot || '.',
      workspace: loaded.anchoredWorkspace,
    },
  };

  await writeFile(path.join(targetCnosRoot, '.detached'), stringifyYaml(marker), 'utf8');
  await writeCnosrc(packageRoot, { root: './.cnos' });

  if (options.json) {
    return printJson({
      packageRoot,
      detachedWorkspace: loaded.anchoredWorkspace,
      cnosRoot: targetCnosRoot,
    });
  }

  return `detached workspace ${loaded.anchoredWorkspace} into ${displayPath(targetCnosRoot, packageRoot)}`;
}

async function runAttach(
  packageRoot: string,
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const force = consumeFlag(cliArgs, '--force');
  const childCnosRoot = path.join(packageRoot, '.cnos');
  const markerPath = path.join(childCnosRoot, '.detached');

  if (!(await exists(markerPath))) {
    throw new Error('workspace attach requires a detached package with .cnos/.detached');
  }

  const marker = parseYaml<DetachedMarker>(await readFile(markerPath, 'utf8'));

  if (!marker?.originalCnosrc?.root || !marker.detachedWorkspace) {
    throw new Error('Invalid .detached marker');
  }

  const parentManifestRoot = path.resolve(packageRoot, marker.originalCnosrc.root);
  const parentLoaded = await loadManifest({ root: parentManifestRoot });
  const workspaceId = marker.originalCnosrc.workspace ?? marker.detachedWorkspace;
  const parentWorkspaceRoot = path.join(parentLoaded.manifestRoot, 'workspaces', workspaceId);

  if ((await exists(parentWorkspaceRoot)) && !force) {
    throw new Error(`workspace "${workspaceId}" already exists in parent root. Use --force to overwrite.`);
  }

  if (force) {
    await rm(parentWorkspaceRoot, { recursive: true, force: true });
  }

  await mkdir(parentWorkspaceRoot, { recursive: true });

  for (const folderName of ['values', 'secrets', 'env', 'profiles']) {
    await copyIfExists(path.join(childCnosRoot, folderName), path.join(parentWorkspaceRoot, folderName));
  }

  const rawManifest = parentLoaded.rawManifest as Record<string, unknown>;
  const workspaces = ((rawManifest.workspaces as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  const items = ((workspaces.items as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  items[workspaceId] = items[workspaceId] ?? {};
  workspaces.items = items;
  rawManifest.workspaces = workspaces;

  await writeFile(path.join(parentLoaded.manifestRoot, 'cnos.yml'), stringifyYaml(rawManifest), 'utf8');

  const archivePath = path.join(packageRoot, '.cnos.detached.bak');
  await rm(archivePath, { recursive: true, force: true });
  await rename(childCnosRoot, archivePath);
  await writeCnosrc(packageRoot, {
    root: marker.originalCnosrc.root,
    ...(workspaceId ? { workspace: workspaceId } : {}),
  });

  if (options.json) {
    return printJson({
      packageRoot,
      workspace: workspaceId,
      parentRoot: parentLoaded.manifestRoot,
      archivedTo: archivePath,
    });
  }

  return `attached workspace ${workspaceId} to ${displayPath(parentLoaded.manifestRoot, packageRoot)}`;
}

export async function runWorkspace(
  args: string[] = [],
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const [action] = args;
  const cliArgs = [...(options.cliArgs ?? [])];
  const packageRoot = path.resolve(consumeOption(cliArgs, '--package-root') ?? options.root ?? process.cwd());

  switch (action) {
    case 'detach':
      return runDetach(packageRoot, { ...options, cliArgs });
    case 'attach':
      return runAttach(packageRoot, { ...options, cliArgs });
    default:
      throw new Error(`Unsupported workspace action: ${action ?? '(missing)'}`);
  }
}
