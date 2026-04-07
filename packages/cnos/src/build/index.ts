import { type CnosCreateOptions } from '@kitsy/cnos-core';

import { createCnos } from '../createCnos.js';

export async function resolveBrowserData(
  options: CnosCreateOptions = {},
): Promise<Record<string, unknown>> {
  const runtime = await createCnos(options);
  const browserData: Record<string, unknown> = {};

  for (const [key, entry] of runtime.graph.entries) {
    if (!key.startsWith('public.')) {
      continue;
    }

    browserData[key] = entry.value;
  }

  return browserData;
}
