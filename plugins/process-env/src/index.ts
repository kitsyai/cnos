import { envVarToLogicalKey, type ConfigEntry, type EnvMappingConfig, type LoaderPlugin } from '@kitsy/cnos-core';

const PROCESS_ENV_PLUGIN_ID = '@kitsy/cnos/plugins/process-env';
const PROCESS_GRAPH_OMIT = new Set([
  '__CNOS_GRAPH__',
  '__CNOS_SECRET_PAYLOAD__',
  '__CNOS_SESSION_KEY__',
]);

interface ProcessEnvSourceConfig {
  envMapping?: EnvMappingConfig;
}

export function processEnvEntriesFromObject(
  env: Record<string, string | undefined>,
  mapping: EnvMappingConfig = {},
  workspaceId = 'default',
): ConfigEntry[] {
  return Object.entries(env).flatMap(([envVar, value]) => {
    if (typeof value !== 'string') {
      return [];
    }

    const logicalKey = envVarToLogicalKey(envVar, mapping);

    if (!logicalKey) {
      return [];
    }

    return [
      {
        key: logicalKey,
        value,
        namespace: logicalKey.startsWith('secret.') ? 'secret' : 'value',
        sourceId: 'process-env',
        pluginId: PROCESS_ENV_PLUGIN_ID,
        workspaceId,
        origin: {
          envVar,
        },
      } satisfies ConfigEntry,
    ];
  });
}

export function processNamespaceEntriesFromContext(
  env: Record<string, string | undefined>,
  workspaceId = 'default',
): ConfigEntry[] {
  const envEntries = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .filter(([envVar]) => !PROCESS_GRAPH_OMIT.has(envVar))
    .map(([envVar, value]) => ({
      key: `process.env.${envVar}`,
      value,
      namespace: 'process',
      sourceId: 'process-runtime',
      pluginId: PROCESS_ENV_PLUGIN_ID,
      workspaceId,
      origin: {
        envVar,
      },
    } satisfies ConfigEntry));

  const runtimeEntries: ConfigEntry[] = [
    {
      key: 'process.cwd',
      value: process.cwd(),
      namespace: 'process',
      sourceId: 'process-runtime',
      pluginId: PROCESS_ENV_PLUGIN_ID,
      workspaceId,
    },
    {
      key: 'process.platform',
      value: process.platform,
      namespace: 'process',
      sourceId: 'process-runtime',
      pluginId: PROCESS_ENV_PLUGIN_ID,
      workspaceId,
    },
    {
      key: 'process.arch',
      value: process.arch,
      namespace: 'process',
      sourceId: 'process-runtime',
      pluginId: PROCESS_ENV_PLUGIN_ID,
      workspaceId,
    },
    {
      key: 'process.node.version',
      value: process.version,
      namespace: 'process',
      sourceId: 'process-runtime',
      pluginId: PROCESS_ENV_PLUGIN_ID,
      workspaceId,
    },
    {
      key: 'process.args.raw',
      value: process.argv.slice(2),
      namespace: 'process',
      sourceId: 'process-runtime',
      pluginId: PROCESS_ENV_PLUGIN_ID,
      workspaceId,
    },
  ];

  return [...runtimeEntries, ...envEntries];
}

export function createProcessEnvPlugin(): LoaderPlugin {
  return {
    id: 'process-env',
    kind: 'loader',
    async load(context) {
      const config = context.manifestConfig as ProcessEnvSourceConfig;
      const env = context.processEnv ?? process.env;

      return [
        ...processEnvEntriesFromObject(
          env,
          config.envMapping,
          context.workspace.workspaceId,
        ),
        ...processNamespaceEntriesFromContext(env, context.workspace.workspaceId),
      ];
    },
  };
}
