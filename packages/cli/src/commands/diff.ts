import { flattenObject } from '@kitsy/cnos-core';

import { printJson } from '../format/printJson.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';

function flattenRuntime(runtime: Awaited<ReturnType<typeof createRuntimeService>>): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      Object.entries(flattenObject(runtime.toNamespace('value'))).map(([key, value]) => [`value.${key}`, value]),
    ),
    ...Object.fromEntries(
      Object.entries(flattenObject(runtime.toNamespace('secret'))).map(([key, value]) => [`secret.${key}`, value]),
    ),
  };
}

export async function runDiff(
  leftProfile: string,
  rightProfile: string,
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const leftRuntime = await createRuntimeService({
    ...options,
    profile: leftProfile,
  });
  const rightRuntime = await createRuntimeService({
    ...options,
    profile: rightProfile,
  });
  const left = flattenRuntime(leftRuntime);
  const right = flattenRuntime(rightRuntime);
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort((a, b) =>
    a.localeCompare(b),
  );
  const rows = keys
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .map((key) => ({
      key,
      left: left[key] ?? null,
      right: right[key] ?? null,
    }));

  if (options.json) {
    return printJson(rows);
  }

  return rows.map((row) => `${row.key}: ${JSON.stringify(row.left)} -> ${JSON.stringify(row.right)}`).join('\n');
}
