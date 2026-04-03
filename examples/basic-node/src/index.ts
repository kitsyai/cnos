import { createCnos } from '@kitsy/cnos';

export async function runBasicNodeExample() {
  const runtime = await createCnos({
    entries: [
      { key: 'app.name', value: 'basic-node' },
      { key: 'app.port', value: 3000 },
    ],
    manifest: {
      name: 'basic-node',
    },
  });

  return {
    name: runtime.require('app.name'),
    port: runtime.require('app.port'),
  };
}
