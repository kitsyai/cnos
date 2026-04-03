import { createCnos } from '@kitsy/cnos';

export async function createRuntimeService() {
  return createCnos({
    root: process.cwd(),
  });
}
