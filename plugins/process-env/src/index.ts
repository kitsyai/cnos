import { envVarToLogicalKey, type ConfigEntry, type EnvMappingConfig, type LoaderPlugin } from '@kitsy/cnos-core';

const PROCESS_ENV_PLUGIN_ID = '@kitsy/cnos/plugins/process-env';

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

export function createProcessEnvPlugin(): LoaderPlugin {
  return {
    id: 'process-env',
    kind: 'loader',
    async load(context) {
      const config = context.manifestConfig as ProcessEnvSourceConfig;
      return processEnvEntriesFromObject(
        context.processEnv ?? process.env,
        config.envMapping,
        context.workspace.workspaceId,
      );
    },
  };
}
