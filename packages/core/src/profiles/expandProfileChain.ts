import type { ExpandedProfileChain } from '../types/profile.js';

export function expandProfileChain(activeProfile: string): ExpandedProfileChain {
  return {
    activeProfile,
    profiles: [activeProfile],
  };
}
