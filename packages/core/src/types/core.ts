export interface CnosConfigEntry {
  key: string;
  value: unknown;
  source?: string;
  profile?: string;
  secret?: boolean;
}

export interface CnosInspectRecord extends CnosConfigEntry {
  resolved: boolean;
}

export interface CnosRuntime {
  manifest: CnosManifest;
  plugins: CnosPlugin[];
  read(key: string): unknown;
  require(key: string): unknown;
  inspect(): CnosInspectRecord[];
}

export interface CnosCreateOptions {
  manifest?: CnosManifest;
  plugins?: CnosPlugin[];
  entries?: CnosConfigEntry[];
}

import type { CnosManifest } from './manifest.js';
import type { CnosPlugin } from './plugin.js';
