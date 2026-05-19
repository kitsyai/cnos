import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  envVarToLogicalKey,
  resolveWorkspaceScopedPath,
  toPortablePath,
  type ConfigEntry,
  type EnvMappingConfig,
  type LoaderPlugin,
} from '@kitsy/cnos-core';

const DOTENV_PLUGIN_ID = '@kitsy/cnos/plugins/dotenv';

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

function isEscapedCharacter(value: string, index: number): boolean {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }

  return slashCount % 2 === 1;
}

function findClosingQuote(value: string, quote: '"' | "'"): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== quote) {
      continue;
    }

    if (quote === '"' && isEscapedCharacter(value, index)) {
      continue;
    }

    return index;
  }

  return -1;
}

export function parseDotenv(document: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const lines = document.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex] ?? '';
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

    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value.startsWith('"') ? '"' : "'";
      let quotedContent = value.slice(1);
      let closingIndex = findClosingQuote(quotedContent, quote);

      while (closingIndex === -1 && lineIndex < lines.length - 1) {
        lineIndex += 1;
        quotedContent = `${quotedContent}\n${lines[lineIndex] ?? ''}`;
        closingIndex = findClosingQuote(quotedContent, quote);
      }

      const rawQuotedValue =
        closingIndex === -1 ? quotedContent : quotedContent.slice(0, closingIndex);
      value = quote === '"' ? parseDoubleQuoted(rawQuotedValue) : rawQuotedValue;
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
  workspaceId = 'default',
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
        workspaceId,
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
      const rootTemplate = config.root ?? './env';
      const fileNames = context.profileActivation.envFiles;
      const entries: ConfigEntry[] = [];

      for (const workspaceRoot of context.workspace.workspaceRoots) {
        const envRoot = resolveWorkspaceScopedPath(workspaceRoot.path, rootTemplate, {
          workspace: workspaceRoot.workspaceId,
        });

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
              toPortablePath(path.relative(path.dirname(context.manifestRoot), absolutePath)),
              workspaceRoot.workspaceId,
            ),
          );
        }
      }

      return entries;
    },
  };
}
