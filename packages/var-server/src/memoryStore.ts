import { BaseVarStore } from './baseStore.js';
import type { VarStore } from './types.js';

class MemoryVarStore extends BaseVarStore {
  readonly persistent = false;

  protected async persist(): Promise<void> {
    // Ephemeral: nothing to durably record. State lives only in memory and is empty on restart.
  }
}

/**
 * Ephemeral in-memory var store. Full mutation semantics (validation, generations,
 * optimistic concurrency, audit) while the process is alive; head and history are empty
 * after a restart. Default for embedded/latched authorities — the overlay makes ephemeral
 * mode degrade cleanly to static/default tiers.
 */
export function memoryStore(): VarStore {
  return new MemoryVarStore();
}
