import { expandProfileChain } from './expandProfileChain.js';

export function expandProfileGraph(activeProfile: string) {
  return expandProfileChain(activeProfile);
}
