/**
 * Event kinds recorded in the append-only var log book. The log is the single source of
 * truth: current head = fold of the log; the log is never rewritten (rollback appends a
 * new activation). The log carries `var.*` documents and opaque `secret.*` refs only —
 * never secret material.
 */
export type VarEventKind = 'revision-created' | 'activated' | 'deactivated' | 'rejected';

/** A single append-only log event. */
export interface VarEvent {
  kind: VarEventKind;
  /** Scope key this event concerns (a var key or a group). */
  scope: string;
  /** Who performed the mutation (operator/workload identity); free-form for W2. */
  actor?: string;
  /** Human reason attached to the mutation, surfaced in audit/history. */
  reason?: string;
  /** ISO timestamp when the event was written. */
  timestamp: string;
  /** Revision this event concerns (created / activated / rejected). */
  revision?: string;
  /** Previous active revision at write time (audit). */
  previousRevision?: string;
  /** Generation allocated by this event (activated / deactivated). Monotonic per scope. */
  generation?: number;
  /** Previous generation at write time (audit). */
  previousGeneration?: number;
  /** Document schema id in force at write time (self-describing replay). */
  schemaId?: string;
  /** Document schema version in force at write time. */
  schemaVersion?: string;
  /** Created revision document (refs only, never secret material). Present on revision-created. */
  document?: unknown;
  /** Rejection reason (present on rejected). */
  rejectionReason?: string;
  /** Client-supplied idempotency key that produced this event, if any. */
  idempotencyKey?: string;
}

/** A content-addressed, immutable revision document that was successfully created. */
export interface StoredRevision {
  revision: string;
  document: unknown;
  schemaId?: string;
  schemaVersion?: string;
  createdAt: string;
  actor?: string;
}

/** The active runtime head for a scope, matching the http read-plane response body. */
export interface ScopeHead {
  scope: string;
  generation: number;
  revision: string;
  schemaId?: string;
  schemaVersion?: string;
  effectiveAt: string;
  values: Record<string, unknown>;
}

/** Observable status for a scope. Never carries secret material. */
export interface ScopeStatus {
  scope: string;
  active: boolean;
  /** Current generation (last activate/deactivate); 0 when the scope head was never mutated. */
  generation: number;
  revision?: string;
  schemaId?: string;
  schemaVersion?: string;
  effectiveAt?: string;
  source: 'runtime' | 'none';
  lastRejected?: { revision?: string; reason: string; at: string };
}

/** The result of a successful mutation, replayed verbatim for an idempotent retry. */
export interface MutationRecord {
  kind: 'created' | 'activated' | 'deactivated';
  scope: string;
  revision?: string;
  generation: number;
  effectiveAt?: string;
}

/**
 * Pluggable persistence behind the var server. Reads (`head`/`status`/`revision`) are
 * synchronous and lock-free — they observe a single immutable state snapshot per scope,
 * so a concurrent `append` is never partially visible. `append` persists then swaps the
 * in-memory snapshot atomically.
 */
export interface VarStore {
  /** Whether this store durably persists the log (enables restart recovery and replay). */
  readonly persistent: boolean;
  /** Append one event to the log and fold it into in-memory state atomically. */
  append(event: VarEvent): Promise<void>;
  /** Current active head for a scope, or undefined when no head is active. */
  head(scope: string): ScopeHead | undefined;
  /** Current status snapshot for a scope. */
  status(scope: string): ScopeStatus;
  /** Look up a previously created revision document by hash. */
  revision(scope: string, revision: string): StoredRevision | undefined;
  /** Full event log for a scope, in append order. */
  history(scope: string): readonly VarEvent[];
  /** All known scope keys. */
  scopes(): string[];
  /** Highest generation ever allocated for a scope (monotonic; never reused). */
  currentGeneration(scope: string): number;
  /** Replay the recorded result of a prior idempotent mutation, if any. */
  idempotent(key: string): MutationRecord | undefined;
  /** Reconstruct the head state at a past generation. Persistent stores only. */
  replay(scope: string, toGeneration: number): ScopeHead | undefined;
}
