import type { ResolvedGraph } from '../types/core.js';
import type { NormalizedManifest } from '../types/manifest.js';
import type { ValidationIssue } from '../types/plugin.js';

export function validateWorkspaceSafety(
  manifest: NormalizedManifest,
  graph: ResolvedGraph,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const localRoot = graph.workspace.workspaceRoots.find(
    (entry) => entry.scope === 'local' && entry.workspaceId === graph.workspace.workspaceId,
  );

  if (!localRoot) {
    issues.push({
      code: 'workspace.missing-local-root',
      message: `Missing local workspace root for ${graph.workspace.workspaceId}`,
    });
  }

  if (manifest.workspaces.global.allowWrite && !manifest.workspaces.global.enabled) {
    issues.push({
      code: 'workspace.global-write-policy',
      message: 'workspaces.global.allowWrite requires workspaces.global.enabled: true',
    });
  }

  return issues;
}
