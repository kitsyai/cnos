import { createCnos, type LoaderPlugin } from '@kitsy/cnos';
import { fileURLToPath } from 'node:url';

export async function runBasicNodeExample() {
  const fixtureLoader: LoaderPlugin = {
    id: 'basic-node-fixture',
    kind: 'loader',
    async load() {
      return [
        {
          key: 'value.app.name',
          value: 'basic-node',
          namespace: 'value',
          sourceId: 'basic-node-fixture',
          pluginId: 'basic-node-fixture',
        },
        {
          key: 'value.app.port',
          value: 3000,
          namespace: 'value',
          sourceId: 'basic-node-fixture',
          pluginId: 'basic-node-fixture',
        },
      ];
    },
  };
  const runtime = await createCnos({
    root: fileURLToPath(new URL('../cnos', import.meta.url)),
    plugins: [fixtureLoader],
  });

  return {
    name: runtime.require('value.app.name'),
    port: runtime.require('value.app.port'),
  };
}
