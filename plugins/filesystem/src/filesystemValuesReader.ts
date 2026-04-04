import { readFile } from 'node:fs/promises';

import type { ConfigEntry, LoaderPlugin } from '@kitsy/cnos-core';

import { collectFilesystemLayerFiles, yamlObjectToEntries } from './helpers.js';

export function filesystemValuesReader(filePath: string, document: string, workspaceId = 'default'): ConfigEntry[] {
  return yamlObjectToEntries(document, filePath, 'value', 'filesystem-values', workspaceId);
}

export function createFilesystemValuesPlugin(): LoaderPlugin {
  return {
    id: 'filesystem-values',
    kind: 'loader',
    async load(context) {
      const sourceRoot = String(context.manifestConfig.root ?? './');
      const files = await collectFilesystemLayerFiles(
        context.manifestRoot,
        context.workspace.workspaceRoots,
        sourceRoot,
        context.profileActivation.values,
      );
      const entries: ConfigEntry[] = [];

      for (const file of files) {
        const document = await readFile(file.absolutePath, 'utf8');
        entries.push(...filesystemValuesReader(file.relativePath, document, file.workspaceId));
      }

      return entries;
    },
  };
}
