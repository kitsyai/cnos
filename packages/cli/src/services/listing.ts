import { flattenObject } from '@kitsy/cnos-core';

import { createRuntimeService, type RuntimeServiceOptions } from './runtime.js';

export type ListNamespace = 'all' | 'value' | 'secret' | 'meta';

export interface ListEntry {
  key: string;
  value: unknown;
}

export async function listConfigEntries(
  namespace: ListNamespace,
  options: RuntimeServiceOptions & { prefix?: string } = {},
): Promise<ListEntry[]> {
  const runtime = await createRuntimeService(options);
  const namespaces: Array<Exclude<ListNamespace, 'all'>> =
    namespace === 'all' ? ['value', 'secret', 'meta'] : [namespace];
  const entries: ListEntry[] = [];
  const prefix = options.prefix?.trim();

  for (const currentNamespace of namespaces) {
    const projected = flattenObject(runtime.toNamespace(currentNamespace));

    for (const [path, value] of Object.entries(projected)) {
      const key = `${currentNamespace}.${path}`;

      if (prefix && !key.startsWith(prefix) && !path.startsWith(prefix)) {
        continue;
      }

      entries.push({
        key,
        value,
      });
    }
  }

  return entries.sort((left, right) => left.key.localeCompare(right.key));
}
