import { compareSchemaToGraph, formatDriftReport } from '@kitsy/cnos/internal';

import { printJson } from '../format/printJson.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';

export async function runDrift(options: RuntimeServiceOptions = {}): Promise<string> {
  const runtime = await createRuntimeService(options);
  const report = compareSchemaToGraph(runtime);

  if (options.json) {
    return printJson(report);
  }

  return formatDriftReport(report);
}
