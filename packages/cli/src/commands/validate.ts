import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { createValidationSummary } from '../services/validation.js';

export async function runValidate(options: RuntimeServiceOptions = {}): Promise<string> {
  const { summary } = await createValidationSummary(options);

  if (!summary.valid) {
    process.exitCode = 1;
  }

  if (options.json) {
    return printJson(summary);
  }

  return summary.valid
    ? 'validation passed'
    : summary.issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n');
}
