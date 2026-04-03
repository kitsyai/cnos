export interface CnosProfileSelection {
  activeProfile?: string;
  fallbackProfiles?: string[];
}

export interface ExpandedProfileGraph {
  activeProfile?: string;
  profiles: string[];
}
