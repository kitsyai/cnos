import { toCanonicalVarValues } from '@kitsy/cnos-core';

import type {
  MutationRecord,
  ScopeHead,
  ScopeStatus,
  StoredRevision,
  VarEvent,
} from './types.js';

/**
 * Immutable folded state for a single scope. Every mutation produces a fresh ScopeState
 * object; the store swaps the map entry in one synchronous assignment so readers observe
 * either the complete old state or the complete new one, never a mixture.
 */
export interface ScopeState {
  readonly scope: string;
  /** Current generation (last activate/deactivate). 0 when the head was never mutated. */
  readonly generation: number;
  readonly activeRevision: string | undefined;
  readonly activeSchemaId: string | undefined;
  readonly activeSchemaVersion: string | undefined;
  readonly activeEffectiveAt: string | undefined;
  readonly revisions: ReadonlyMap<string, StoredRevision>;
  readonly lastRejected?: { revision?: string; reason: string; at: string };
  readonly events: readonly VarEvent[];
  readonly idempotency: ReadonlyMap<string, MutationRecord>;
}

export function initialScopeState(scope: string): ScopeState {
  return {
    scope,
    generation: 0,
    activeRevision: undefined,
    activeSchemaId: undefined,
    activeSchemaVersion: undefined,
    activeEffectiveAt: undefined,
    revisions: new Map(),
    events: [],
    idempotency: new Map(),
  };
}

function withIdempotency(
  base: ReadonlyMap<string, MutationRecord>,
  event: VarEvent,
  record: MutationRecord,
): ReadonlyMap<string, MutationRecord> {
  if (!event.idempotencyKey) {
    return base;
  }

  const next = new Map(base);
  next.set(event.idempotencyKey, record);
  return next;
}

/** Fold one event into a scope's state, returning a new immutable ScopeState. */
export function applyEvent(state: ScopeState, event: VarEvent): ScopeState {
  const events = [...state.events, event];

  switch (event.kind) {
    case 'revision-created': {
      const revisions = new Map(state.revisions);
      const revision = event.revision as string;
      const stored: StoredRevision = {
        revision,
        document: event.document,
        ...(event.schemaId !== undefined ? { schemaId: event.schemaId } : {}),
        ...(event.schemaVersion !== undefined ? { schemaVersion: event.schemaVersion } : {}),
        createdAt: event.timestamp,
        ...(event.actor !== undefined ? { actor: event.actor } : {}),
      };
      revisions.set(revision, stored);
      return {
        ...state,
        revisions,
        events,
        idempotency: withIdempotency(state.idempotency, event, {
          kind: 'created',
          scope: state.scope,
          revision,
          generation: state.generation,
        }),
      };
    }

    case 'activated': {
      const generation = event.generation ?? state.generation + 1;
      return {
        ...state,
        generation,
        activeRevision: event.revision as string,
        activeSchemaId: event.schemaId,
        activeSchemaVersion: event.schemaVersion,
        activeEffectiveAt: event.timestamp,
        events,
        idempotency: withIdempotency(state.idempotency, event, {
          kind: 'activated',
          scope: state.scope,
          revision: event.revision as string,
          generation,
          effectiveAt: event.timestamp,
        }),
      };
    }

    case 'deactivated': {
      const generation = event.generation ?? state.generation + 1;
      return {
        ...state,
        generation,
        activeRevision: undefined,
        activeSchemaId: undefined,
        activeSchemaVersion: undefined,
        activeEffectiveAt: undefined,
        events,
        idempotency: withIdempotency(state.idempotency, event, {
          kind: 'deactivated',
          scope: state.scope,
          generation,
        }),
      };
    }

    case 'rejected': {
      return {
        ...state,
        lastRejected: {
          ...(event.revision !== undefined ? { revision: event.revision } : {}),
          reason: event.rejectionReason ?? event.reason ?? 'rejected',
          at: event.timestamp,
        },
        events,
      };
    }

    default:
      return { ...state, events };
  }
}

/**
 * Fold one event into a states map, mutating it in place. A plain event touches only its own
 * scope. A cascading (subtree) `deactivated` event (W12) additionally tombstones every scope in
 * `event.cascade`, each as a synthesized per-descendant `deactivated` event allocated its own
 * next generation and recorded in that descendant's own history. The whole subtree therefore
 * folds from a SINGLE durable log line (crash-atomic), and the same routine drives both the live
 * `append` path and log replay/hydration, so a replayed subtree deactivation reconstructs
 * byte-for-byte what the live one produced.
 */
export function applyEventToStates(states: Map<string, ScopeState>, event: VarEvent): void {
  const current = states.get(event.scope) ?? initialScopeState(event.scope);
  states.set(event.scope, applyEvent(current, event));

  if (event.kind !== 'deactivated' || !event.cascade || event.cascade.length === 0) {
    return;
  }

  for (const descendant of event.cascade) {
    const descState = states.get(descendant) ?? initialScopeState(descendant);
    const synthesized: VarEvent = {
      kind: 'deactivated',
      scope: descendant,
      timestamp: event.timestamp,
      generation: descState.generation + 1,
      previousGeneration: descState.generation,
      ...(descState.activeRevision !== undefined ? { previousRevision: descState.activeRevision } : {}),
      ...(event.actor !== undefined ? { actor: event.actor } : {}),
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
      cascadeParent: event.scope,
    };
    states.set(descendant, applyEvent(descState, synthesized));
  }
}

/** Fold a full event log into scope states keyed by scope. */
export function foldEvents(events: Iterable<VarEvent>): Map<string, ScopeState> {
  const states = new Map<string, ScopeState>();

  for (const event of events) {
    applyEventToStates(states, event);
  }

  return states;
}

export function headOf(state: ScopeState | undefined): ScopeHead | undefined {
  if (!state || state.activeRevision === undefined) {
    return undefined;
  }

  const stored = state.revisions.get(state.activeRevision);

  if (!stored) {
    return undefined;
  }

  // Canonical wire shape: `values` is ALWAYS keyed by the full var key minus `var.`.
  // Key scope wraps the as-authored document under its own key; group scope passes the
  // (create-time validated) full-key-keyed document straight through.
  const values = toCanonicalVarValues(state.scope, stored.document);

  return {
    scope: state.scope,
    generation: state.generation,
    revision: state.activeRevision,
    ...(state.activeSchemaId !== undefined ? { schemaId: state.activeSchemaId } : {}),
    ...(state.activeSchemaVersion !== undefined ? { schemaVersion: state.activeSchemaVersion } : {}),
    effectiveAt: state.activeEffectiveAt ?? '',
    values,
  };
}

export function statusOf(state: ScopeState | undefined, scope: string): ScopeStatus {
  if (!state) {
    return { scope, active: false, generation: 0, source: 'none' };
  }

  const active = state.activeRevision !== undefined;
  return {
    scope,
    active,
    generation: state.generation,
    ...(active ? { revision: state.activeRevision } : {}),
    ...(active && state.activeSchemaId !== undefined ? { schemaId: state.activeSchemaId } : {}),
    ...(active && state.activeSchemaVersion !== undefined ? { schemaVersion: state.activeSchemaVersion } : {}),
    ...(active && state.activeEffectiveAt !== undefined ? { effectiveAt: state.activeEffectiveAt } : {}),
    source: active ? 'runtime' : 'none',
    ...(state.lastRejected ? { lastRejected: state.lastRejected } : {}),
  };
}

/** Reconstruct the head at a past generation by folding events up to (and including) it. */
export function replayToGeneration(
  events: readonly VarEvent[],
  scope: string,
  toGeneration: number,
): ScopeHead | undefined {
  let state = initialScopeState(scope);

  for (const event of events) {
    if (event.scope !== scope) {
      continue;
    }

    state = applyEvent(state, event);

    if (
      (event.kind === 'activated' || event.kind === 'deactivated') &&
      event.generation === toGeneration
    ) {
      return headOf(state);
    }
  }

  return undefined;
}
