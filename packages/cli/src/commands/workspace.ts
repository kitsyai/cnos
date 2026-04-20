import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadManifest, parseYaml, stringifyYaml } from '@kitsy/cnos/internal';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { displayPath } from '../format/displayPath.js';
import { printJson } from '../format/printJson.js';
import { ensureGitignore, ensureWorkspaceLayout } from '../services/scaffold.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { createRuntimeService } from '../services/runtime.js';

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

async function moveIfExists(source: string, target: string, force = false): Promise<boolean> {
  if (!(await exists(source))) {
    return false;
  }

  if (force) {
    await rm(target, { recursive: true, force: true });
  } else if (await exists(target)) {
    throw new Error(`Refusing to overwrite existing path ${target}. Use --force to replace it.`);
  }

  await mkdir(path.dirname(target), { recursive: true });
  await rename(source, target);
  return true;
}

async function mergeWorkspaceRootsIntoStandalone(targetCnosRoot: string, sourceRoots: string[]): Promise<void> {
  for (const sourceRoot of sourceRoots) {
    for (const folderName of ['values', 'secrets', 'env', 'profiles']) {
      await copyIfExists(path.join(sourceRoot, folderName), path.join(targetCnosRoot, folderName));
    }
  }
}

async function writeAnchor(packageRoot: string, manifestRoot: string, workspace?: string): Promise<void> {
  const relativeRoot = path.relative(packageRoot, manifestRoot).replace(/\\/g, '/');
  const rootValue =
    relativeRoot.length === 0 ? './.cnos' : relativeRoot.startsWith('.') ? relativeRoot : `./${relativeRoot}`;
  await writeFile(
    path.join(packageRoot, '.cnosrc.yml'),
    stringifyYaml({
      root: rootValue,
      ...(workspace ? { workspace } : {}),
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

function normalizeWorkspaceId(value: string | undefined): string {
  const workspaceId = value?.trim();

  if (!workspaceId) {
    throw new Error('Workspace id is required');
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workspaceId)) {
    throw new Error(`Invalid workspace id "${workspaceId}". Use letters, numbers, dot, underscore, or dash.`);
  }

  return workspaceId;
}

function splitExtends(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  if (value.trim() === 'none') {
    return [];
  }

  const items = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}

async function hasDirectConfigData(cnosRoot: string): Promise<boolean> {
  for (const folderName of ['values', 'secrets', 'env', 'profiles']) {
    const folder = path.join(cnosRoot, folderName);

    if (!(await exists(folder))) {
      continue;
    }

    const entries = await readdir(folder, { withFileTypes: true });
    if (entries.some((entry) => entry.name !== '.gitkeep')) {
      return true;
    }
  }

  return false;
}

async function updateRootAnchorToWorkspace(packageRoot: string, workspaceId: string): Promise<void> {
  const anchorPath = path.join(packageRoot, '.cnosrc.yml');
  const current = (await exists(anchorPath))
    ? parseYaml<Record<string, unknown>>(await readFile(anchorPath, 'utf8'))
    : undefined;

  await writeFile(
    anchorPath,
    stringifyYaml({
      root: typeof current?.root === 'string' ? current.root : './.cnos',
      workspace: workspaceId,
    }),
    'utf8',
  );
}

async function updateWorkspaceContext(packageRoot: string, workspaceId: string): Promise<void> {
  const workspacePath = path.join(packageRoot, '.cnos-workspace.yml');
  const current = (await exists(workspacePath))
    ? parseYaml<Record<string, unknown>>(await readFile(workspacePath, 'utf8'))
    : undefined;

  await writeFile(
    workspacePath,
    stringifyYaml({
      workspace: workspaceId,
      ...(typeof current?.profile === 'string' ? { profile: current.profile } : {}),
      ...(typeof current?.globalRoot === 'string' ? { globalRoot: current.globalRoot } : { globalRoot: '~/.cnos' }),
    }),
    'utf8',
  );
}

async function runDetach(packageRoot: string, options: RuntimeServiceOptions = {}): Promise<string> {
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
  const localRoots = runtime.graph.workspace.workspaceRoots.filter((root) => root.scope === 'local').map((root) => root.path);

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
  await writeFile(path.join(packageRoot, '.cnosrc.yml'), stringifyYaml({ root: './.cnos' }), 'utf8');

  if (options.json) {
    return printJson({
      packageRoot,
      detachedWorkspace: loaded.anchoredWorkspace,
      cnosRoot: targetCnosRoot,
    });
  }

  return `detached workspace ${loaded.anchoredWorkspace} into ${displayPath(targetCnosRoot, packageRoot)}`;
}

async function runAttach(packageRoot: string, options: RuntimeServiceOptions = {}): Promise<string> {
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

  if (parentLoaded.rootResolution.readOnly) {
    throw new Error(
      `Cannot attach workspace because the parent CNOS root is remote and read-only (${parentLoaded.rootResolution.rootUri}).`,
    );
  }

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

  const rawManifest = structuredClone(parentLoaded.rawManifest as Record<string, unknown>);
  const workspaces = ((rawManifest.workspaces as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  const items = ((workspaces.items as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  items[workspaceId] = items[workspaceId] ?? {};
  workspaces.items = items;
  rawManifest.workspaces = workspaces;

  await writeFile(path.join(parentLoaded.manifestRoot, 'cnos.yml'), stringifyYaml(rawManifest), 'utf8');

  const archivePath = path.join(packageRoot, '.cnos.detached.bak');
  await rm(archivePath, { recursive: true, force: true });
  await rename(childCnosRoot, archivePath);
  await writeAnchor(packageRoot, parentLoaded.manifestRoot, workspaceId);

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

async function runList(
  manifestCwd: string,
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const loaded = await loadManifest({
    ...(options.root ? { root: options.root } : {}),
    cwd: manifestCwd,
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  });
  const entries = Object.entries(loaded.manifest.workspaces.items)
    .map(([id, config]) => ({
      id,
      extends: config.extends,
      default: loaded.manifest.workspaces.default === id,
      path: path.join(loaded.manifestRoot, 'workspaces', id),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  if (options.json) {
    return printJson({
      default: loaded.manifest.workspaces.default,
      workspaces: entries,
    });
  }

  if (entries.length === 0) {
    return 'no workspaces declared';
  }

  return entries
    .map((entry) => {
      const tags = [
        entry.default ? 'default' : undefined,
        entry.extends.length > 0 ? `extends=${entry.extends.join(',')}` : undefined,
      ].filter(Boolean);
      return `${entry.id}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`;
    })
    .join('\n');
}

async function runEnable(
  manifestCwd: string,
  packageRoot: string,
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const cliArgs = [...(options.cliArgs ?? [])];

  if (cliArgs.length > 0) {
    throw new Error(`Unsupported workspace arguments: ${cliArgs.join(' ')}`);
  }

  const loaded = await loadManifest({
    ...(options.root ? { root: options.root } : {}),
    cwd: manifestCwd,
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  });

  if (loaded.rootResolution.readOnly) {
    throw new Error(
      `Cannot enable workspace mode because the active CNOS root is remote and read-only (${loaded.rootResolution.rootUri}). Clone the config repo and edit it directly.`,
    );
  }

  const rawManifest = structuredClone(loaded.rawManifest as Record<string, unknown>);
  const rawWorkspaces = ((rawManifest.workspaces as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  const rawItems = ((rawWorkspaces.items as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;

  if (Object.keys(rawItems).length > 0) {
    throw new Error('This CNOS root is already in workspace mode.');
  }

  const cnosRoot = loaded.manifestRoot;
  const baseWorkspaceRoot = path.join(cnosRoot, 'workspaces', 'base');

  if (await exists(baseWorkspaceRoot)) {
    throw new Error('Cannot enable workspace mode because .cnos/workspaces/base already exists.');
  }

  const moved: string[] = [];

  for (const folderName of ['values', 'secrets', 'env', 'profiles']) {
    if (await moveIfExists(path.join(cnosRoot, folderName), path.join(baseWorkspaceRoot, folderName))) {
      moved.push(folderName);
    }
  }

  await ensureWorkspaceLayout(cnosRoot, 'base');
  rawWorkspaces.default = 'base';
  rawWorkspaces.items = {
    base: {},
  };
  rawManifest.workspaces = rawWorkspaces;

  await writeFile(path.join(cnosRoot, 'cnos.yml'), stringifyYaml(rawManifest), 'utf8');
  await updateRootAnchorToWorkspace(packageRoot, 'base');
  await updateWorkspaceContext(packageRoot, 'base');
  await ensureGitignore(path.dirname(cnosRoot));

  if (options.json) {
    return printJson({
      root: path.dirname(cnosRoot),
      workspace: 'base',
      moved,
    });
  }

  const movedSummary = moved.length > 0 ? `; moved ${moved.join(', ')} into .cnos/workspaces/base` : '';
  return `enabled workspace mode at ${displayPath(path.dirname(cnosRoot), packageRoot)} with base workspace${movedSummary}`;
}

async function runAddOrScaffold(
  action: 'add' | 'scaffold',
  workspaceId: string,
  manifestCwd: string,
  packageRoot: string,
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const extendsOption = splitExtends(consumeOption(cliArgs, '--extends'));
  const force = consumeFlag(cliArgs, '--force');

  if (cliArgs.length > 0) {
    throw new Error(`Unsupported workspace arguments: ${cliArgs.join(' ')}`);
  }

  const loaded = await loadManifest({
    ...(options.root ? { root: options.root } : {}),
    cwd: manifestCwd,
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  });

  if (loaded.rootResolution.readOnly) {
    throw new Error(
      `Cannot ${action} workspace because the active CNOS root is remote and read-only (${loaded.rootResolution.rootUri}). Clone the config repo and edit it directly.`,
    );
  }

  const manifestRoot = loaded.manifestRoot;
  const cnosRoot = manifestRoot;
  const rawManifest = structuredClone(loaded.rawManifest as Record<string, unknown>);
  const rawWorkspaces = ((rawManifest.workspaces as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  const rawItems = ((rawWorkspaces.items as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  const isWorkspaceMode = Object.keys(rawItems).length > 0;
  const directConfigPresent = await hasDirectConfigData(cnosRoot);

  if (!isWorkspaceMode || directConfigPresent) {
    throw new Error(
      'This CNOS root is not ready for child workspaces yet. Run `cnos workspace enable` first to convert the flat project into workspace mode.',
    );
  }

  if (rawItems[workspaceId] && !force) {
    throw new Error(`workspace "${workspaceId}" already exists. Use --force to update its manifest entry and anchor.`);
  }

  const defaultExtends =
    extendsOption ??
    (!['base', 'root'].includes(workspaceId) && rawItems.base
      ? ['base']
      : undefined);

  rawItems[workspaceId] = defaultExtends && defaultExtends.length > 0 ? { extends: defaultExtends } : {};
  rawWorkspaces.items = rawItems;
  rawWorkspaces.default = (rawWorkspaces.default as string | undefined) ?? workspaceId;
  rawManifest.workspaces = rawWorkspaces;

  const workspaceRoot = path.join(cnosRoot, 'workspaces', workspaceId);
  const created = await ensureWorkspaceLayout(cnosRoot, workspaceId);
  await writeFile(path.join(cnosRoot, 'cnos.yml'), stringifyYaml(rawManifest), 'utf8');
  await ensureGitignore(path.dirname(cnosRoot));

  await writeAnchor(packageRoot, cnosRoot, workspaceId);
  await updateWorkspaceContext(packageRoot, workspaceId);

  const result = {
    workspace: workspaceId,
    root: path.dirname(cnosRoot),
    packageRoot,
    created,
  };

  if (options.json) {
    return printJson(result);
  }

  const verb = action === 'add' ? 'added' : 'scaffolded';
  return `${verb} workspace ${workspaceId} at ${displayPath(workspaceRoot, packageRoot)}`;
}

async function runRemove(
  workspaceId: string,
  manifestCwd: string,
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const cliArgs = [...(options.cliArgs ?? [])];
  consumeFlag(cliArgs, '--force');

  if (cliArgs.length > 0) {
    throw new Error(`Unsupported workspace arguments: ${cliArgs.join(' ')}`);
  }

  const loaded = await loadManifest({
    ...(options.root ? { root: options.root } : {}),
    cwd: manifestCwd,
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  });

  if (loaded.rootResolution.readOnly) {
    throw new Error(
      `Cannot remove workspace because the active CNOS root is remote and read-only (${loaded.rootResolution.rootUri}). Clone the config repo and edit it directly.`,
    );
  }

  const rawManifest = structuredClone(loaded.rawManifest as Record<string, unknown>);
  const rawWorkspaces = ((rawManifest.workspaces as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  const rawItems = ((rawWorkspaces.items as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;

  if (!rawItems[workspaceId]) {
    throw new Error(`workspace "${workspaceId}" does not exist`);
  }

  if ((rawWorkspaces.default as string | undefined) === workspaceId) {
    throw new Error(`Cannot remove workspace "${workspaceId}" because it is the default workspace. Change workspaces.default first.`);
  }

  delete rawItems[workspaceId];
  rawWorkspaces.items = rawItems;
  rawManifest.workspaces = rawWorkspaces;

  await writeFile(path.join(loaded.manifestRoot, 'cnos.yml'), stringifyYaml(rawManifest), 'utf8');
  await rm(path.join(loaded.manifestRoot, 'workspaces', workspaceId), { recursive: true, force: true });

  if (options.json) {
    return printJson({
      workspace: workspaceId,
      removedFrom: loaded.manifestRoot,
    });
  }

  return `removed workspace ${workspaceId}`;
}

export async function runWorkspace(
  args: string[] = [],
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const [action, workspaceArg] = args;
  const baseCliArgs = [...(options.cliArgs ?? [])];
  const manifestCwd = path.resolve(options.root ?? process.cwd());
  const packageRoot = path.resolve(consumeOption(baseCliArgs, '--package-root') ?? options.root ?? process.cwd());

  switch (action) {
    case 'attach':
      return runAttach(packageRoot, { ...options, cliArgs: baseCliArgs });
    case 'detach':
      return runDetach(packageRoot, { ...options, cliArgs: baseCliArgs });
    case 'enable':
      return runEnable(manifestCwd, packageRoot, { ...options, cliArgs: baseCliArgs });
    case 'list':
      return runList(manifestCwd, options);
    case 'add':
      return runAddOrScaffold('add', normalizeWorkspaceId(workspaceArg), manifestCwd, packageRoot, {
        ...options,
        cliArgs: baseCliArgs,
      });
    case 'scaffold':
      return runAddOrScaffold('scaffold', normalizeWorkspaceId(workspaceArg), manifestCwd, packageRoot, {
        ...options,
        cliArgs: baseCliArgs,
      });
    case 'remove':
    case 'delete':
      return runRemove(normalizeWorkspaceId(workspaceArg), manifestCwd, {
        ...options,
        cliArgs: baseCliArgs,
      });
    default:
      throw new Error(`Unsupported workspace action: ${action ?? '(missing)'}`);
  }
}
