import type { ExpandedProfileGraph } from '../types/profile.js';

export function expandProfileGraph(
  activeProfile?: string,
  fallbackProfiles: string[] = [],
): ExpandedProfileGraph {
  const profiles = [activeProfile, ...fallbackProfiles].filter(
    (profile): profile is string => Boolean(profile),
  );

  return {
    ...(activeProfile ? { activeProfile } : {}),
    profiles: [...new Set(profiles)],
  };
}
