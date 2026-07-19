import type { CnosRuntime } from '../types/core.js';
import type { ValidationIssue, ValidationResult, ValidationSummary, ValidatorPlugin } from '../types/plugin.js';
import { validateEnvMappingCollisions } from './envMapping.js';
import { validatePublicSafety } from './publicSafety.js';
import { validateVarManifest } from './validateVars.js';
import { validateWorkspaceSafety } from './workspaceSafety.js';

export async function validateRuntime(runtime: CnosRuntime): Promise<ValidationSummary> {
  const validatorPlugins = runtime.plugins.filter(
    (plugin): plugin is ValidatorPlugin => plugin.kind === 'validator',
  );
  const pluginResults = await Promise.all(
    validatorPlugins.map((plugin) =>
      plugin.validate(runtime.graph, {
        manifest: runtime.manifest,
        schema: runtime.manifest.schema,
      }),
    ),
  );
  const builtInResults: ValidationResult[] = [
    {
      pluginId: 'public-safety',
      valid: true,
      issues: validatePublicSafety(runtime.manifest),
    },
    {
      pluginId: 'env-mapping',
      valid: true,
      issues: validateEnvMappingCollisions(runtime.manifest, runtime.graph),
    },
    {
      pluginId: 'workspace-safety',
      valid: true,
      issues: validateWorkspaceSafety(runtime.manifest, runtime.graph),
    },
    {
      pluginId: 'var-manifest',
      valid: true,
      issues: validateVarManifest(runtime.manifest),
    },
  ].map((result) => ({
    ...result,
    valid: result.issues.length === 0,
  }));
  const results = [...pluginResults, ...builtInResults];
  const issues: ValidationIssue[] = results.flatMap((result) => result.issues);

  return {
    valid: issues.length === 0,
    issues,
    results,
  };
}
