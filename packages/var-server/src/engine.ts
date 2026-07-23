import {
  isVarGroupScope,
  validateDocumentValue,
  type DocumentSchemaDefinition,
  type ValidationIssue,
} from '@kitsy/cnos-core';

import { CnosVarConflictError, CnosVarNotFoundError, CnosVarValidationError } from './errors.js';
import { revisionHash } from './hash.js';
import type { MutationRecord, ScopeHead, ScopeStatus, VarEvent, VarStore } from './types.js';

export interface VarEngineOptions {
  /** Document schemas keyed by schemaId (e.g. `agentic-lanes/v1`), used to validate revisions. */
  documents?: Record<string, DocumentSchemaDefinition>;
  /** Clock override for deterministic tests; returns an ISO timestamp. */
  clock?: () => string;
  /**
   * TEST SEAM (W12 subtree-deactivation race tests). Awaited inside the engine mutation lock,
   * immediately before an `activated`/`deactivated` event is appended — the exact point at which
   * the store state is about to change. A test can block here to prove that a mutation submitted
   * while another is mid-flight cannot interleave (it is queued behind the lock). Never used in
   * production.
   */
  onBeforeAppend?: (event: VarEvent) => void | Promise<void>;
}

/** Common actor/reason/idempotency metadata carried by every mutation. */
export interface MutationContext {
  actor?: string;
  reason?: string;
  idempotencyKey?: string;
}

export interface CreateRevisionInput extends MutationContext {
  scope: string;
  document: unknown;
  /** Document schema id to validate against; when omitted the revision is stored unvalidated (scalar var). */
  schemaId?: string;
  schemaVersion?: string;
}

export interface CreateRevisionResult {
  scope: string;
  revision: string;
  generation: number;
  created: boolean;
}

export interface ActivateInput extends MutationContext {
  scope: string;
  revision: string;
  /** REQUIRED optimistic-concurrency guard: must equal the scope's current generation. */
  expectedGeneration: number;
}

export interface DeactivateInput extends MutationContext {
  scope: string;
  expectedGeneration: number;
}

export interface RollbackInput extends MutationContext {
  scope: string;
  expectedGeneration: number;
  /** Prior revision to re-activate as a new generation. */
  toRevision?: string;
  /** Alternatively, a prior generation whose revision should be re-activated. */
  toGeneration?: number;
}

export interface ActivationResult {
  scope: string;
  generation: number;
  revision: string;
  effectiveAt: string;
}

export interface DeactivationResult {
  scope: string;
  generation: number;
  active: false;
}

export interface ValidateResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/**
 * A commit-path notification. Fired synchronously after an activation/deactivation event has
 * been appended to the store (so `store.head(scope)` already reflects the new state). `head`
 * is the new canonical head for the scope, or `undefined` after a deactivation. Transports
 * (rpc Subscribe, ws/sse) hook this to push the new batch to matching subscribers.
 */
export type CommitListener = (event: { scope: string; kind: 'activated' | 'deactivated'; head: ScopeHead | undefined }) => void;

/**
 * The control-plane mutation engine on top of a {@link VarStore}. Owns validation,
 * content-addressed revision creation, atomic activation with monotonic generations,
 * optimistic concurrency, rollback, idempotency, history, status, and replay.
 */
export class VarEngine {
  private readonly documents: Record<string, DocumentSchemaDefinition>;
  private readonly clock: () => string;
  private readonly onBeforeAppend: ((event: VarEvent) => void | Promise<void>) | undefined;
  /**
   * SINGLE ENGINE-WIDE MUTATION SERIALIZATION (W12). Every mutation — create, activate,
   * deactivate, rollback — runs to completion under this one chained lock, so a subtree
   * deactivation's `enumerate active descendants → build event → append` is atomic with respect
   * to EVERY other mutation. A child activation therefore linearizes either fully BEFORE the
   * deactivation (it is in the store when the descendants are enumerated, so it is cleared) or
   * fully AFTER it (it is queued behind the lock and commits fresh, so it survives) — never
   * interleaved. This replaces the previous per-scope locks: a subtree touches many scopes, so a
   * per-scope lock could not serialize it against an activation on a different descendant scope.
   * A single global lock is the deadlock-free way to get that (control-plane mutation rates are
   * low; reads stay lock-free and are unaffected). No cross-scope ordering is ever inferred from
   * timestamps or unrelated per-scope revisions.
   */
  private mutationChain: Promise<unknown> = Promise.resolve();
  /** Commit-path listeners: fire after every accepted activation/deactivation (incl. rollback). */
  private readonly commitListeners = new Set<CommitListener>();

  constructor(
    private readonly store: VarStore,
    options: VarEngineOptions = {},
  ) {
    this.documents = options.documents ?? {};
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.onBeforeAppend = options.onBeforeAppend;
  }

  private now(): string {
    return this.clock();
  }

  private async withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Reserve this mutation's slot SYNCHRONOUSLY at call time, so submission order is the
    // linearization order: `deactivate(g)` called before `activate(g.key)` is guaranteed to
    // acquire the lock first.
    this.mutationChain = previous.then(() => gate);

    await previous.catch(() => undefined);

    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Awaited immediately before an activate/deactivate append (test seam; no-op in production). */
  private async beforeAppend(event: VarEvent): Promise<void> {
    if (this.onBeforeAppend) {
      await this.onBeforeAppend(event);
    }
  }

  private schemaFor(schemaId: string | undefined): DocumentSchemaDefinition | undefined {
    if (schemaId === undefined) {
      return undefined;
    }

    return this.documents[schemaId];
  }

  private validateDocument(scope: string, document: unknown, schemaId?: string): ValidationIssue[] {
    const schema = this.schemaFor(schemaId);

    if (!schema) {
      if (schemaId !== undefined) {
        return [
          {
            code: 'document.unknown-schema',
            key: scope,
            message: `No document schema "${schemaId}" is registered on this var server; cannot validate the revision.`,
          },
        ];
      }

      return [];
    }

    return validateDocumentValue(document, schema, { ...(schemaId ? { schemaId } : {}), path: scope });
  }

  /**
   * Structural guard for GROUP-scoped revisions: the document must be an object whose every
   * top-level key is a full var key under `<group>.` (the canonical uniform-keying rule).
   * Key-scoped revisions are leaf documents and are exempt (they validate against their
   * bound document schema instead).
   */
  private validateGroupScopeShape(scope: string, document: unknown): ValidationIssue[] {
    if (!isVarGroupScope(scope)) {
      return [];
    }

    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      return [
        {
          code: 'var.group-scope-shape',
          key: scope,
          message: `Group-scoped revision for "${scope}" must be an object keyed by full var keys (e.g. "${scope}.<rest>").`,
        },
      ];
    }

    const prefix = `${scope}.`;
    return Object.keys(document as Record<string, unknown>)
      .filter((key) => !key.startsWith(prefix))
      .map((key) => ({
        code: 'var.group-scope-shape',
        key: scope,
        message: `Group-scoped revision for "${scope}" has top-level key "${key}" that does not start with "${prefix}". Group documents are keyed by full var keys.`,
      }));
  }

  /** Dry-run validation of a candidate revision. Never touches the store. */
  validateRevision(document: unknown, schemaId?: string, scope = 'candidate'): ValidateResult {
    const issues = [
      ...this.validateDocument(scope, document, schemaId),
      ...this.validateGroupScopeShape(scope, document),
    ];
    return { valid: issues.length === 0, issues };
  }

  /**
   * Create an immutable, content-addressed revision. Validates against its document schema
   * BEFORE storing — an invalid candidate produces a `rejected` audit event and throws,
   * leaving the last-known-good head untouched.
   */
  async createRevision(input: CreateRevisionInput): Promise<CreateRevisionResult> {
    return this.withMutationLock(async () => {
      if (input.idempotencyKey) {
        const replayed = this.store.idempotent(input.idempotencyKey);

        if (replayed && replayed.kind === 'created') {
          return {
            scope: replayed.scope,
            revision: replayed.revision as string,
            generation: replayed.generation,
            created: false,
          };
        }
      }

      const issues = [
        ...this.validateDocument(input.scope, input.document, input.schemaId),
        ...this.validateGroupScopeShape(input.scope, input.document),
      ];

      if (issues.length > 0) {
        await this.store.append(
          this.event('rejected', {
            scope: input.scope,
            ...(input.actor !== undefined ? { actor: input.actor } : {}),
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            rejectionReason: issues.map((issue) => `${issue.code}: ${issue.message}`).join('; '),
            ...(input.schemaId !== undefined ? { schemaId: input.schemaId } : {}),
          }),
        );
        throw new CnosVarValidationError(input.scope, issues);
      }

      const revision = revisionHash(input.document);
      const existing = this.store.revision(input.scope, revision);

      if (!existing) {
        await this.store.append(
          this.event('revision-created', {
            scope: input.scope,
            revision,
            document: input.document,
            ...(input.actor !== undefined ? { actor: input.actor } : {}),
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            ...(input.schemaId !== undefined ? { schemaId: input.schemaId } : {}),
            ...(input.schemaVersion !== undefined ? { schemaVersion: input.schemaVersion } : {}),
            ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          }),
        );
      }

      return {
        scope: input.scope,
        revision,
        generation: this.store.currentGeneration(input.scope),
        created: !existing,
      };
    });
  }

  /** Atomically point the scope head at a revision, allocating the next monotonic generation. */
  async activate(input: ActivateInput): Promise<ActivationResult> {
    return this.withMutationLock(async () => {
      if (input.idempotencyKey) {
        const replayed = this.store.idempotent(input.idempotencyKey);

        if (replayed && replayed.kind === 'activated') {
          return {
            scope: replayed.scope,
            generation: replayed.generation,
            revision: replayed.revision as string,
            effectiveAt: replayed.effectiveAt as string,
          };
        }
      }

      const stored = this.store.revision(input.scope, input.revision);

      if (!stored) {
        throw new CnosVarNotFoundError(
          `Cannot activate unknown revision "${input.revision}" for var scope "${input.scope}". Create it first.`,
        );
      }

      this.assertGeneration(input.scope, input.expectedGeneration);

      const previous = this.store.status(input.scope);
      const generation = previous.generation + 1;
      const effectiveAt = this.now();

      const activatedEvent = this.event('activated', {
          scope: input.scope,
          revision: input.revision,
          generation,
          previousGeneration: previous.generation,
          ...(previous.revision !== undefined ? { previousRevision: previous.revision } : {}),
          ...(stored.schemaId !== undefined ? { schemaId: stored.schemaId } : {}),
          ...(stored.schemaVersion !== undefined ? { schemaVersion: stored.schemaVersion } : {}),
          ...(input.actor !== undefined ? { actor: input.actor } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          timestamp: effectiveAt,
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        });

      await this.beforeAppend(activatedEvent);
      await this.store.append(activatedEvent);

      this.emitCommit(input.scope, 'activated');
      return { scope: input.scope, generation, revision: input.revision, effectiveAt };
    });
  }

  /**
   * SUBTREE (HIERARCHICAL) DEACTIVATION (W12). Remove the runtime head for `scope` AND every
   * currently-active descendant scope, so consumers fall back to static `value.*` / defaults
   * across the whole subtree. This is NOT a persistent ancestor mask: it clears the descendants
   * ACTIVE AT COMMIT TIME and nothing else. A child activated LATER revives without parent
   * reactivation (histories: `deactivate(g); activate(g.key)` ⇒ g.key ACTIVE), and reactivating
   * the parent does NOT resurrect these tombstoned children (`deactivate(g); activate(g)` leaves
   * them inactive). A key-scoped deactivation affects only that key's own subtree — never its
   * parent or siblings.
   *
   * Atomicity + durability: the whole subtree is one appended event carrying the descendant scope
   * list, so it folds into every affected scope in a single, crash-atomic step (a torn multi-line
   * write can never leave the parent inactive while a child stays active). Serialization: this
   * runs under the engine mutation lock, so the `enumerate → build → append` is atomic against
   * every activation — a child activation is either enumerated-and-cleared (linearized before) or
   * queued-and-survives (linearized after), never interleaved.
   */
  async deactivate(input: DeactivateInput): Promise<DeactivationResult> {
    return this.withMutationLock(async () => {
      if (input.idempotencyKey) {
        const replayed = this.store.idempotent(input.idempotencyKey);

        if (replayed && replayed.kind === 'deactivated') {
          return { scope: replayed.scope, generation: replayed.generation, active: false };
        }
      }

      this.assertGeneration(input.scope, input.expectedGeneration);

      const previous = this.store.status(input.scope);
      const generation = previous.generation + 1;

      // Enumerate the descendant scopes ACTIVE right now (a committed scope strictly nested under
      // `scope` whose head is present). Under the mutation lock this snapshot cannot change before
      // the append, so exactly these descendants are the ones "active when the deactivation is
      // committed". Sorted for a deterministic, faithful audit record.
      const prefix = `${input.scope}.`;
      const cascade = this.store
        .scopes()
        .filter((candidate) => candidate.startsWith(prefix) && this.store.head(candidate) !== undefined)
        .sort();

      const deactivatedEvent = this.event('deactivated', {
        scope: input.scope,
        generation,
        previousGeneration: previous.generation,
        ...(previous.revision !== undefined ? { previousRevision: previous.revision } : {}),
        ...(input.actor !== undefined ? { actor: input.actor } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(cascade.length > 0 ? { cascade } : {}),
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      });

      await this.beforeAppend(deactivatedEvent);
      await this.store.append(deactivatedEvent);

      // One LIVE cascading commit event for the parent: subscribers cascade-clear the subtree as
      // of this moment (the live wire no_head carries cascade=true). Each cleared descendant scope
      // ALSO fires its own commit event, so a client subscribed to a descendant scope directly is
      // notified even though it does not match the parent scope string.
      this.emitCommit(input.scope, 'deactivated');
      for (const descendant of cascade) {
        this.emitCommit(descendant, 'deactivated');
      }

      return { scope: input.scope, generation, active: false };
    });
  }

  /** Activate a prior revision as a NEW generation (append-only history). */
  async rollback(input: RollbackInput): Promise<ActivationResult> {
    const target = this.resolveRollbackRevision(input);
    return this.activate({
      scope: input.scope,
      revision: target,
      expectedGeneration: input.expectedGeneration,
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
      reason: input.reason ?? `rollback to ${target}`,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    });
  }

  /**
   * Register a commit-path listener fired after every accepted activation/deactivation
   * (rollback flows through `activate`, so it is covered). Returns an unsubscribe function.
   * The reusable seam behind the rpc Subscribe transport; ws/sse reuse it unchanged.
   */
  onCommit(listener: CommitListener): () => void {
    this.commitListeners.add(listener);
    return () => {
      this.commitListeners.delete(listener);
    };
  }

  private emitCommit(scope: string, kind: 'activated' | 'deactivated'): void {
    if (this.commitListeners.size === 0) {
      return;
    }

    const head = this.store.head(scope);

    for (const listener of this.commitListeners) {
      try {
        listener({ scope, kind, head });
      } catch {
        /* a listener error never affects the commit — the snapshot is already active */
      }
    }
  }

  status(scope: string): ScopeStatus {
    return this.store.status(scope);
  }

  history(scope: string): readonly VarEvent[] {
    return this.store.history(scope);
  }

  head(scope: string): ScopeHead | undefined {
    return this.store.head(scope);
  }

  replay(scope: string, toGeneration: number): ScopeHead | undefined {
    return this.store.replay(scope, toGeneration);
  }

  scopes(): string[] {
    return this.store.scopes();
  }

  private resolveRollbackRevision(input: RollbackInput): string {
    if (input.toRevision) {
      return input.toRevision;
    }

    if (input.toGeneration !== undefined) {
      const activation = this.store
        .history(input.scope)
        .find((event) => event.kind === 'activated' && event.generation === input.toGeneration);

      if (!activation?.revision) {
        throw new CnosVarNotFoundError(
          `Cannot roll back var scope "${input.scope}" to generation ${input.toGeneration}: no active revision existed at that generation.`,
        );
      }

      return activation.revision;
    }

    throw new CnosVarNotFoundError(
      `Rollback for var scope "${input.scope}" requires either toRevision or toGeneration.`,
    );
  }

  private assertGeneration(scope: string, expectedGeneration: number): void {
    const current = this.store.currentGeneration(scope);

    if (expectedGeneration !== current) {
      throw new CnosVarConflictError(scope, expectedGeneration, current);
    }
  }

  private event(kind: VarEvent['kind'], partial: Omit<Partial<VarEvent>, 'kind'> & { scope: string }): VarEvent {
    return {
      kind,
      timestamp: this.now(),
      ...partial,
    } as VarEvent;
  }
}

export function createVarEngine(store: VarStore, options: VarEngineOptions = {}): VarEngine {
  return new VarEngine(store, options);
}

export type { MutationRecord };
