import { createCnos, type LoaderPlugin } from '@kitsy/cnos';
import { fileURLToPath } from 'node:url';

export async function runMonorepoAppExample() {
  const fixtureLoader: LoaderPlugin = {
    id: 'monorepo-app-fixture',
    kind: 'loader',
    async load() {
      return [
        {
          key: 'value.workspace.name',
          value: 'cnos-monorepo',
          namespace: 'value',
          sourceId: 'monorepo-app-fixture',
          pluginId: 'monorepo-app-fixture',
          workspaceId: 'monorepo-app',
        },
        {
          key: 'value.apps.web.port',
          value: 4000,
          namespace: 'value',
          sourceId: 'monorepo-app-fixture',
          pluginId: 'monorepo-app-fixture',
          workspaceId: 'monorepo-app',
        },
      ];
    },
  };
  const runtime = await createCnos({
    root: fileURLToPath(new URL('../cnos', import.meta.url)),
    plugins: [fixtureLoader],
  });

  return runtime.toNamespace('value');
}
