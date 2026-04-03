export interface CnosManifestProfile {
  name: string;
  extends?: string[];
}

export interface CnosManifest {
  name: string;
  version?: string;
  profiles?: CnosManifestProfile[];
  entries?: string[];
}
