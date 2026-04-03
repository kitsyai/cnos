import { readFile } from 'node:fs/promises';

import type { ConfigEntry, LoaderPlugin } from '@kitsy/cnos-core';

import { collectFilesystemLayerFiles, yamlObjectToEntries } from './helpers.js';

export function filesystemSecretsReader(filePath: string, document: string, workspaceId = 'default'): ConfigEntry[] {
  return yamlObjectToEntries(document, filePath, 'secret', 'filesystem-secrets', workspaceId);
}

function toWorkspaceRelativeSourceRoot(sourceRoot: string): string {
  return sourceRoot.replace(/^[./\\]*workspaces[\\/]\{workspace\}[\\/]/, './');
}

export function createFilesystemSecretsPlugin(): LoaderPlugin {
  return {
    id: 'filesystem-secrets',
    kind: 'loader',
    async load(context) {
      const sourceRoot = toWorkspaceRelativeSourceRoot(
        String(context.manifestConfig.root ?? './workspaces/{workspace}/secrets'),
      );
      const files = await collectFilesystemLayerFiles(
        context.manifestRoot,
        context.workspace.workspaceRoots,
        sourceRoot,
        context.profileActivation.secrets,
      );
      const entries: ConfigEntry[] = [];

      for (const file of files) {
        const document = await readFile(file.absolutePath, 'utf8');
        entries.push(...filesystemSecretsReader(file.relativePath, document, file.workspaceId));
      }

      return entries;
    },
  };
}
