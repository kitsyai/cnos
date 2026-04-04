import {
  createCnos as createCoreCnos,
  type CnosCreateOptions,
  type CnosRuntime,
} from '@kitsy/cnos-core';
import packageJson from '../package.json';

import { defaultPlugins } from './defaultPlugins.js';

export async function createCnos(options: CnosCreateOptions = {}): Promise<CnosRuntime> {
  return createCoreCnos({
    ...options,
    cnosVersion: packageJson.version,
    plugins: [...defaultPlugins(), ...(options.plugins ?? [])],
  });
}
