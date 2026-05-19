import { loadManifest } from '@kitsy/cnos/internal';

import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { evaluateDoctor, repairSecretEnvMappings } from '../services/doctor.js';

export async function runDoctor(options: RuntimeServiceOptions = {}): Promise<string> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const shouldFixSecretEnvMappings = cliArgs.includes('--fix-secret-env-mappings');
  const repairResult = shouldFixSecretEnvMappings ? await repairSecretEnvMappings(options) : undefined;
  const loadedManifest = await loadManifest({
    ...(options.root ? { root: options.root } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
    ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
    ...(typeof options.cacheTtlSeconds === 'number' ? { cacheTtlSeconds: options.cacheTtlSeconds } : {}),
    ...(options.forceRefresh ? { forceRefresh: true } : {}),
  });
  const hasSchema = Object.keys(loadedManifest.manifest.schema).length > 0;
  const specPointer = hasSchema ? 'Run cnos spec doctor to review config spec coverage.' : undefined;
  const checks = await evaluateDoctor(options);
  const hasFailures = checks.some((check) => !check.ok);

  if (hasFailures) {
    process.exitCode = 1;
  }

  if (options.json) {
    return printJson({
      ...(repairResult ? { repair: repairResult } : {}),
      checks,
      ...(specPointer ? { guidance: [specPointer] } : {}),
    });
  }

  const repairLine =
    repairResult
      ? repairResult.removed.length > 0
        ? `REPAIRED secret-env-mappings: removed ${repairResult.removed.map((entry) => `${entry.envVar} -> ${entry.logicalKey}`).join(', ')}`
        : 'REPAIRED secret-env-mappings: no secret env mappings found'
      : undefined;

  return [repairLine, ...checks.map((check) => `${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.details}`), specPointer]
    .filter((value): value is string => Boolean(value))
    .join('\n');
}
