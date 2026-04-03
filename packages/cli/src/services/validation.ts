import { validateRuntime, type ValidationSummary } from '@kitsy/cnos-core';

import { createRuntimeService, type RuntimeServiceOptions } from './runtime.js';

export async function createValidationSummary(
  options: RuntimeServiceOptions = {},
): Promise<{ summary: ValidationSummary; runtime: Awaited<ReturnType<typeof createRuntimeService>> }> {
  const runtime = await createRuntimeService(options);
  const summary = await validateRuntime(runtime);

  return {
    summary,
    runtime,
  };
}
