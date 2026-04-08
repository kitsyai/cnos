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
      const customNamespaces = Object.entries(context.manifest.namespaces)
        .filter(
          ([namespace, definition]) =>
            namespace !== 'value' &&
            namespace !== 'secret' &&
            definition.kind === 'data' &&
            !definition.sensitive,
        )
        .map(([namespace]) => namespace);
      const entries: ConfigEntry[] = [];

      for (const file of files) {
        const document = await readFile(file.absolutePath, 'utf8');
        entries.push(...filesystemValuesReader(file.relativePath, document, file.workspaceId));
      }

      for (const namespace of customNamespaces) {
        const layers = [
          namespace,
          ...context.profileChain
            .filter((profile) => profile !== 'base')
            .map((profile) => `profiles/${profile}/${namespace}`),
        ];
        const namespaceFiles = await collectFilesystemLayerFiles(
          context.manifestRoot,
          context.workspace.workspaceRoots,
          sourceRoot,
          layers,
        );

        for (const file of namespaceFiles) {
          const document = await readFile(file.absolutePath, 'utf8');
          entries.push(...yamlObjectToEntries(document, file.relativePath, namespace, 'filesystem-values', file.workspaceId));
        }
      }

      return entries;
    },
  };
}
