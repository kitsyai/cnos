import type { WorkspaceContext } from '../types/workspace.js';
import { expandProfileChain } from './expandProfileChain.js';

export async function expandProfileGraph(
  activeProfile: string,
  options?: { manifestRoot?: string; workspace?: WorkspaceContext },
) {
  return expandProfileChain(activeProfile, options);
}
