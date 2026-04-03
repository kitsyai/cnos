import { expandProfileChain } from './expandProfileChain.js';

export async function expandProfileGraph(activeProfile: string, options?: { cnosRoot?: string }) {
  return expandProfileChain(activeProfile, options);
}
