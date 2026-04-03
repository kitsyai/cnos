import type { CnosConfigEntry, CnosRuntime } from './core.js';

export interface CnosPluginContext {
  manifestName: string;
}

export interface CnosPlugin {
  name: string;
  setup?(context: CnosPluginContext): void | Promise<void>;
  collect?(): CnosConfigEntry[] | Promise<CnosConfigEntry[]>;
  extendRuntime?(runtime: CnosRuntime): void | Promise<void>;
}
