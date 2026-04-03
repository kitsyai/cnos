import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { envVarToLogicalKey, type ConfigEntry, type EnvMappingConfig, type LoaderPlugin } from '@kitsy/cnos-core';

const DOTENV_PLUGIN_ID = '@kitsy/cnos-plugin-dotenv';

interface DotenvSourceConfig {
  root?: string;
  envMapping?: EnvMappingConfig;
}

function parseDoubleQuoted(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

export function parseDotenv(document: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of document.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separatorIndex = withoutExport.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const envVar = withoutExport.slice(0, separatorIndex).trim();
    let value = withoutExport.slice(separatorIndex + 1).trim();

    if (!envVar) {
      continue;
    }

    if (value.startsWith('"') && value.endsWith('"')) {
      value = parseDoubleQuoted(value.slice(1, -1));
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }

    parsed[envVar] = value;
  }

  return parsed;
}

export function dotenvEntriesFromObject(
  values: Record<string, string>,
  mapping: EnvMappingConfig = {},
  originFile?: string,
): ConfigEntry[] {
  return Object.entries(values).flatMap(([envVar, value]) => {
    const logicalKey = envVarToLogicalKey(envVar, mapping);

    if (!logicalKey) {
      return [];
    }

    return [
      {
        key: logicalKey,
        value,
        namespace: logicalKey.startsWith('secret.') ? 'secret' : 'value',
        sourceId: 'dotenv',
        pluginId: DOTENV_PLUGIN_ID,
        origin: {
          envVar,
          ...(originFile ? { file: originFile } : {}),
        },
      } satisfies ConfigEntry,
    ];
  });
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

export function createDotenvPlugin(): LoaderPlugin {
  return {
    id: 'dotenv',
    kind: 'loader',
    async load(context) {
      const config = context.manifestConfig as DotenvSourceConfig;
      const envRoot = path.resolve(context.cnosRoot, config.root ?? './env');
      const workspaceRoot = path.dirname(context.cnosRoot);
      const fileNames = context.profileActivation.envFiles;
      const entries: ConfigEntry[] = [];

      for (const fileName of fileNames) {
        const absolutePath = path.join(envRoot, fileName);
        const document = await readIfPresent(absolutePath);

        if (!document) {
          continue;
        }

        entries.push(
          ...dotenvEntriesFromObject(
            parseDotenv(document),
            config.envMapping,
            path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/'),
          ),
        );
      }

      return entries;
    },
  };
}
