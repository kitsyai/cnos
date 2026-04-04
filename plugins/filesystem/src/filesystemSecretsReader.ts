import { readFile } from 'node:fs/promises';

import type { ConfigEntry, LoaderPlugin } from '@kitsy/cnos-core';

import {
  collectFilesystemLayerFiles,
  resolveSecretValue,
  toSecretReferenceMetadata,
  yamlObjectToEntries,
} from './helpers.js';

export function filesystemSecretsReader(filePath: string, document: string, workspaceId = 'default'): ConfigEntry[] {
  return yamlObjectToEntries(document, filePath, 'secret', 'filesystem-secrets', workspaceId);
}

export function createFilesystemSecretsPlugin(): LoaderPlugin {
  return {
    id: 'filesystem-secrets',
    kind: 'loader',
    async load(context) {
      const sourceRoot = String(context.manifestConfig.root ?? './');
      const files = await collectFilesystemLayerFiles(
        context.manifestRoot,
        context.workspace.workspaceRoots,
        sourceRoot,
        context.profileActivation.secrets,
      );
      const entries: ConfigEntry[] = [];

      for (const file of files) {
        const document = await readFile(file.absolutePath, 'utf8');
        const fileEntries = filesystemSecretsReader(file.relativePath, document, file.workspaceId);

        for (const entry of fileEntries) {
          const metadata = toSecretReferenceMetadata(entry.value);
          const resolvedValue = await resolveSecretValue(entry.value, context.processEnv);

          entries.push({
            ...entry,
            value: resolvedValue,
            ...(metadata ? { metadata } : {}),
          });
        }
      }

      return entries;
    },
  };
}
