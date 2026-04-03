export type ProfileResolveFrom = 'cli.profile' | 'env.CNOS_PROFILE' | 'default';

export type ProfileSource = 'cli' | 'env' | 'manifest-default';

export interface ProfileDefinitionFile {
  name?: string;
  extends?: string | string[];
  activate?: {
    values?: string[];
    secrets?: string[];
    envFiles?: string[];
  };
}

export interface NormalizedProfileDefinition {
  name: string;
  extends: string[];
  activate: {
    values: string[];
    secrets: string[];
    envFiles: string[];
  };
  filePath?: string;
}

export interface ResolvedProfile {
  profile: string;
  source: ProfileSource;
}

export interface ProfileActivation {
  values: string[];
  secrets: string[];
  envFiles: string[];
}

export interface ExpandedProfileChain {
  activeProfile: string;
  profiles: string[];
  activation: ProfileActivation;
}
