import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { evaluateDoctor } from '../services/doctor.js';

export async function runDoctor(options: RuntimeServiceOptions = {}): Promise<string> {
  const checks = await evaluateDoctor(options);
  const hasFailures = checks.some((check) => !check.ok);

  if (hasFailures) {
    process.exitCode = 1;
  }

  if (options.json) {
    return printJson(checks);
  }

  return checks.map((check) => `${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.details}`).join('\n');
}
