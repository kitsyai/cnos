import { CnosVarStoreError } from './errors.js';
import {
  applyEventToStates,
  foldEvents,
  headOf,
  replayToGeneration,
  statusOf,
  type ScopeState,
} from './scopeState.js';
import type {
  MutationRecord,
  ScopeHead,
  ScopeStatus,
  StoredRevision,
  VarEvent,
  VarStore,
} from './types.js';

/**
 * Shared fold/read machinery for the built-in stores. Subclasses supply persistence via
 * `persist` and seed initial state via `hydrate`. Reads are synchronous and lock-free;
 * `append` persists first, then swaps the scope's immutable state snapshot in one step.
 */
export abstract class BaseVarStore implements VarStore {
  protected states = new Map<string, ScopeState>();

  abstract readonly persistent: boolean;

  /** Durably record the event before it becomes visible. No-op for ephemeral stores. */
  protected abstract persist(event: VarEvent): Promise<void>;

  /** Rebuild in-memory state from an existing log (restart recovery). */
  protected hydrate(events: Iterable<VarEvent>): void {
    this.states = foldEvents(events);
  }

  async append(event: VarEvent): Promise<void> {
    await this.persist(event);
    // A cascading (subtree) `deactivated` event folds into MULTIPLE scope states — the parent and
    // every descendant it cleared — but persists as ONE durable line, so the whole subtree
    // mutation is crash-atomic. The multiple `set` calls run synchronously (no await between
    // them), so a lock-free reader observes either the whole pre-mutation subtree or the whole
    // post-mutation one, never a mixture.
    applyEventToStates(this.states, event);
  }

  head(scope: string): ScopeHead | undefined {
    return headOf(this.states.get(scope));
  }

  status(scope: string): ScopeStatus {
    return statusOf(this.states.get(scope), scope);
  }

  revision(scope: string, revision: string): StoredRevision | undefined {
    return this.states.get(scope)?.revisions.get(revision);
  }

  history(scope: string): readonly VarEvent[] {
    return this.states.get(scope)?.events ?? [];
  }

  scopes(): string[] {
    return [...this.states.keys()].sort((left, right) => left.localeCompare(right));
  }

  currentGeneration(scope: string): number {
    return this.states.get(scope)?.generation ?? 0;
  }

  idempotent(key: string): MutationRecord | undefined {
    for (const state of this.states.values()) {
      const record = state.idempotency.get(key);

      if (record) {
        return record;
      }
    }

    return undefined;
  }

  replay(scope: string, toGeneration: number): ScopeHead | undefined {
    if (!this.persistent) {
      throw new CnosVarStoreError(
        `Replay to generation ${toGeneration} for scope "${scope}" requires a persistent store. The active store is ephemeral.`,
      );
    }

    const events = this.states.get(scope)?.events ?? [];
    return replayToGeneration(events, scope, toGeneration);
  }
}
