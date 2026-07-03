import type { WorkspaceContext } from '../types/workspace.js';
import type { ExpandedProfileChain } from '../types/profile.js';
import { expandProfileChain } from './expandProfileChain.js';

export async function expandProfileGraph(
  activeProfile: string,
  options?: { manifestRoot?: string; workspace?: WorkspaceContext; usePrivate?: boolean },
): Promise<ExpandedProfileChain> {
  return expandProfileChain(activeProfile, options);
}
