import { joinConfigPath, type ConfigEntry, type LoaderPlugin, type NamespaceName } from '@kitsy/cnos-core';

const CLI_ARGS_PLUGIN_ID = '@kitsy/cnos/plugins/cli-args';

interface ParsedCliArg {
  key: string;
  value: string;
  raw: string;
}

function isNamespaceName(value: string): value is Exclude<NamespaceName, 'meta'> {
  return value === 'value' || value === 'secret';
}

export function parseCliArgs(args: string[]): ParsedCliArg[] {
  const parsed: ParsedCliArg[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg?.startsWith('--')) {
      continue;
    }

    if (arg === '--profile') {
      index += 1;
      continue;
    }

    if (arg.startsWith('--profile=')) {
      continue;
    }

    const body = arg.slice(2);
    const separatorIndex = body.indexOf('=');

    if (separatorIndex >= 0) {
      parsed.push({
        key: body.slice(0, separatorIndex),
        value: body.slice(separatorIndex + 1),
        raw: arg,
      });
      continue;
    }

    const nextValue = args[index + 1];

    if (nextValue && !nextValue.startsWith('--')) {
      parsed.push({
        key: body,
        value: nextValue,
        raw: `${arg} ${nextValue}`,
      });
      index += 1;
    }
  }

  return parsed;
}

export function cliArgEntriesFromArgs(args: string[], workspaceId = 'default'): ConfigEntry[] {
  return parseCliArgs(args).flatMap(({ key, value, raw }) => {
    const [candidateNamespace = '', ...pathSegments] = key.split('.');

    if (!isNamespaceName(candidateNamespace) || pathSegments.length === 0) {
      return [];
    }

    const namespace = candidateNamespace;
    const logicalKey = `${namespace}.${joinConfigPath(pathSegments.join('.'))}`;

    return [
      {
        key: logicalKey,
        value,
        namespace,
        sourceId: 'cli-args',
        pluginId: CLI_ARGS_PLUGIN_ID,
        workspaceId,
        origin: {
          cliArg: raw,
        },
      } satisfies ConfigEntry,
    ];
  });
}

export function createCliArgsPlugin(): LoaderPlugin {
  return {
    id: 'cli-args',
    kind: 'loader',
    async load(context) {
      return cliArgEntriesFromArgs(context.cliArgs ?? [], context.workspace.workspaceId);
    },
  };
}
