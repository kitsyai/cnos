import {
  createCnos as createCoreCnos,
  type CnosCreateOptions,
  type CnosRuntime,
} from '@kitsy/cnos-core';

import { defaultPlugins } from './defaultPlugins.js';

export async function createCnos(options: CnosCreateOptions = {}): Promise<CnosRuntime> {
  return createCoreCnos({
    ...options,
    plugins: [...defaultPlugins(), ...(options.plugins ?? [])],
  });
}
