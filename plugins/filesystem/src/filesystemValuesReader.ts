import { readFile } from 'node:fs/promises';

import type { ConfigEntry, LoaderPlugin } from '@kitsy/cnos-core';

import { collectFilesystemLayerFiles, yamlObjectToEntries } from './helpers.js';

export function filesystemValuesReader(filePath: string, document: string): ConfigEntry[] {
  return yamlObjectToEntries(document, filePath, 'value', 'filesystem-values');
}

export function createFilesystemValuesPlugin(): LoaderPlugin {
  return {
    id: 'filesystem-values',
    kind: 'loader',
    async load(context) {
      const sourceRoot = String(context.manifestConfig.root ?? './values');
      const files = await collectFilesystemLayerFiles(
        context.cnosRoot,
        sourceRoot,
        context.profileActivation.values,
      );
      const entries: ConfigEntry[] = [];

      for (const file of files) {
        const document = await readFile(file.absolutePath, 'utf8');
        entries.push(...filesystemValuesReader(file.relativePath, document));
      }

      return entries;
    },
  };
}
