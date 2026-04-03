import { createCnos } from '@kitsy/cnos';

export async function createRuntimeService() {
  return createCnos({
    manifest: {
      name: 'cnos-cli',
    },
  });
}
