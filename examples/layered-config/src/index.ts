import { createCnos } from '@kitsy/cnos';
import { toPublicEnv } from '@kitsy/cnos-plugin-env-export';

export async function runLayeredConfigExample() {
  const runtime = await createCnos({
    entries: [
      { key: 'app.name', value: 'layered-config' },
      { key: 'app.stage', value: 'prod' },
      { key: 'app.secret', value: 'hidden', secret: true },
    ],
    manifest: {
      name: 'layered-config',
      profiles: [{ name: 'prod' }],
    },
  });

  return {
    inspect: runtime.inspect(),
    publicEnv: toPublicEnv(runtime.inspect()),
  };
}
