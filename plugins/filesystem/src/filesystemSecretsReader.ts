import { readFile } from 'node:fs/promises';

import type { ConfigEntry, LoaderPlugin } from '@kitsy/cnos-core';

import { collectFilesystemLayerFiles, yamlObjectToEntries } from './helpers.js';

export function filesystemSecretsReader(filePath: string, document: string): ConfigEntry[] {
  return yamlObjectToEntries(document, filePath, 'secret', 'filesystem-secrets');
}

export function createFilesystemSecretsPlugin(): LoaderPlugin {
  return {
    id: 'filesystem-secrets',
    kind: 'loader',
    async load(context) {
      const sourceRoot = String(context.manifestConfig.root ?? './secrets');
      const files = await collectFilesystemLayerFiles(
        context.cnosRoot,
        sourceRoot,
        context.profileActivation.secrets,
      );
      const entries: ConfigEntry[] = [];

      for (const file of files) {
        const document = await readFile(file.absolutePath, 'utf8');
        entries.push(...filesystemSecretsReader(file.relativePath, document));
      }

      return entries;
    },
  };
}
