import { createCnos, type LoaderPlugin } from '@kitsy/cnos';
import { fileURLToPath } from 'node:url';

export async function runLayeredConfigExample() {
  const fixtureLoader: LoaderPlugin = {
    id: 'layered-config-fixture',
    kind: 'loader',
    async load() {
      return [
        {
          key: 'value.app.name',
          value: 'layered-config',
          namespace: 'value',
          sourceId: 'layered-config-fixture',
          pluginId: 'layered-config-fixture',
        },
        {
          key: 'value.app.stage',
          value: 'prod',
          namespace: 'value',
          sourceId: 'layered-config-fixture',
          pluginId: 'layered-config-fixture',
        },
        {
          key: 'secret.app.token',
          value: 'hidden',
          namespace: 'secret',
          sourceId: 'layered-config-fixture',
          pluginId: 'layered-config-fixture',
        },
      ];
    },
  };
  const runtime = await createCnos({
    root: fileURLToPath(new URL('../cnos', import.meta.url)),
    plugins: [fixtureLoader],
  });

  return {
    inspect: runtime.inspect('value.app.stage'),
    meta: runtime.toNamespace('meta'),
  };
}
