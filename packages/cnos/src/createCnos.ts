import {
  createCnos as createCoreCnos,
  type CnosCreateOptions,
  type CnosRuntime,
} from '@kitsy/cnos-core';
import packageJson from '../package.json';

import { defaultPlugins } from './defaultPlugins.js';
import { defaultVarSourceProviders } from './defaultVarSourceProviders.js';
import { setSingletonRuntime } from './runtime/state.js';

export async function createCnos(options: CnosCreateOptions = {}): Promise<CnosRuntime> {
  const runtime = await createCoreCnos({
    ...options,
    processEnv: options.processEnv ?? process.env,
    cnosVersion: packageJson.version,
    plugins: [...defaultPlugins(), ...(options.plugins ?? [])],
    varSourceProviders: [...defaultVarSourceProviders(), ...(options.varSourceProviders ?? [])],
  });

  setSingletonRuntime(runtime);

  return runtime;
}
