import { readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  CnosManifestError,
  flattenObject,
  parseYaml,
  toPortablePath,
  type ConfigEntry,
  type NamespaceName,
  type WorkspaceRoot,
} from '@kitsy/cnos-core';

const YAML_EXTENSIONS = new Set(['.yml', '.yaml']);
const FILESYSTEM_PLUGIN_ID = '@kitsy/cnos-plugin-filesystem';

export interface FilesystemLoaderFile {
  absolutePath: string;
  relativePath: string;
  workspaceId: string;
}

async function existsDirectory(targetPath: string): Promise<boolean> {
  try {
    const stat = await readdir(targetPath);
    void stat;
    return true;
  } catch {
    return false;
  }
}

async function collectYamlFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      results.push(...(await collectYamlFiles(absolutePath)));
      continue;
    }

    if (entry.isFile() && YAML_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(absolutePath);
    }
  }

  return results;
}

export async function collectFilesystemLayerFiles(
  manifestRoot: string,
  workspaceRoots: WorkspaceRoot[],
  sourceRoot: string,
  activeLayers: string[],
): Promise<FilesystemLoaderFile[]> {
  const files: FilesystemLoaderFile[] = [];
  const repoRoot = path.dirname(manifestRoot);

  for (const workspaceRoot of workspaceRoots) {
    const resolvedRoot = path.resolve(workspaceRoot.path, sourceRoot);

    for (const layer of activeLayers) {
      const layerRoot = path.join(resolvedRoot, layer);

      if (!(await existsDirectory(layerRoot))) {
        continue;
      }

      for (const absolutePath of await collectYamlFiles(layerRoot)) {
        const relativePath = path.relative(repoRoot, absolutePath);
        files.push({
          absolutePath,
          relativePath: toPortablePath(relativePath.startsWith('..') ? absolutePath : relativePath),
          workspaceId: workspaceRoot.workspaceId,
        });
      }
    }
  }

  return files;
}

function assertObjectDocument(value: unknown, filePath: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CnosManifestError('Filesystem loader expected a YAML object document', filePath);
  }

  return value as Record<string, unknown>;
}

export function yamlObjectToEntries(
  document: string,
  filePath: string,
  namespace: NamespaceName,
  sourceId: string,
  workspaceId = 'default',
): ConfigEntry[] {
  const parsed = assertObjectDocument(parseYaml<unknown>(document), filePath);
  const flattened = flattenObject(parsed);

  return Object.entries(flattened).map(([key, value]) => ({
    key: `${namespace}.${key}`,
    value,
    namespace,
    sourceId,
    pluginId: FILESYSTEM_PLUGIN_ID,
    workspaceId,
    origin: {
      file: filePath,
    },
  }));
}
