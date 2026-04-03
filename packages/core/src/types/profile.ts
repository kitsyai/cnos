export type ProfileResolveFrom = 'cli.profile' | 'env.CNOS_PROFILE' | 'default';

export type ProfileSource = 'cli' | 'env' | 'manifest-default';

export interface ResolvedProfile {
  profile: string;
  source: ProfileSource;
}

export interface ExpandedProfileChain {
  activeProfile: string;
  profiles: string[];
}
