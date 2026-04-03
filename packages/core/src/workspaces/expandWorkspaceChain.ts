import { CnosManifestError } from '../errors.js';
import type { NormalizedWorkspaceItem } from '../types/workspace.js';

export function expandWorkspaceChain(
  workspaceId: string,
  items: Record<string, NormalizedWorkspaceItem>,
): string[] {
  if (Object.keys(items).length === 0) {
    return [workspaceId];
  }

  if (!items[workspaceId]) {
    throw new CnosManifestError(`Unknown workspace "${workspaceId}"`);
  }

  const visiting = new Set<string>();
  const resolved = new Set<string>();
  const chain: string[] = [];

  const visit = (currentWorkspaceId: string): void => {
    if (resolved.has(currentWorkspaceId)) {
      return;
    }

    if (visiting.has(currentWorkspaceId)) {
      throw new CnosManifestError(`Detected workspace inheritance cycle involving "${currentWorkspaceId}"`);
    }

    const item = items[currentWorkspaceId];

    if (!item) {
      throw new CnosManifestError(`Unknown workspace "${currentWorkspaceId}"`);
    }

    visiting.add(currentWorkspaceId);

    for (const parentWorkspaceId of item.extends) {
      visit(parentWorkspaceId);
    }

    visiting.delete(currentWorkspaceId);
    resolved.add(currentWorkspaceId);
    chain.push(currentWorkspaceId);
  };

  visit(workspaceId);

  return chain;
}
