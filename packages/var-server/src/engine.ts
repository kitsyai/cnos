import { validateDocumentValue, type DocumentSchemaDefinition, type ValidationIssue } from '@kitsy/cnos-core';

import { CnosVarConflictError, CnosVarNotFoundError, CnosVarValidationError } from './errors.js';
import { revisionHash } from './hash.js';
import type { MutationRecord, ScopeHead, ScopeStatus, VarEvent, VarStore } from './types.js';

export interface VarEngineOptions {
  /** Document schemas keyed by schemaId (e.g. `agentic-lanes/v1`), used to validate revisions. */
  documents?: Record<string, DocumentSchemaDefinition>;
  /** Clock override for deterministic tests; returns an ISO timestamp. */
  clock?: () => string;
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
 * The control-plane mutation engine on top of a {@link VarStore}. Owns validation,
 * content-addressed revision creation, atomic activation with monotonic generations,
 * optimistic concurrency, rollback, idempotency, history, status, and replay.
 */
export class VarEngine {
  private readonly documents: Record<string, DocumentSchemaDefinition>;
  private readonly clock: () => string;
  /** Per-scope serialization: read-generation → build-event → append happens under one lock. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: VarStore,
    options: VarEngineOptions = {},
  ) {
    this.documents = options.documents ?? {};
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  private now(): string {
    return this.clock();
  }

  private async withScopeLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      scope,
      previous.then(() => gate),
    );

    await previous.catch(() => undefined);

    try {
      return await fn();
    } finally {
      release();
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

  /** Dry-run validation of a candidate revision. Never touches the store. */
  validateRevision(document: unknown, schemaId?: string, scope = 'candidate'): ValidateResult {
    const issues = this.validateDocument(scope, document, schemaId);
    return { valid: issues.length === 0, issues };
  }

  /**
   * Create an immutable, content-addressed revision. Validates against its document schema
   * BEFORE storing — an invalid candidate produces a `rejected` audit event and throws,
   * leaving the last-known-good head untouched.
   */
  async createRevision(input: CreateRevisionInput): Promise<CreateRevisionResult> {
    return this.withScopeLock(input.scope, async () => {
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

      const issues = this.validateDocument(input.scope, input.document, input.schemaId);

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
    return this.withScopeLock(input.scope, async () => {
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

      await this.store.append(
        this.event('activated', {
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
        }),
      );

      return { scope: input.scope, generation, revision: input.revision, effectiveAt };
    });
  }

  /** Remove the runtime head so consumers fall back to static `value.*` / defaults. */
  async deactivate(input: DeactivateInput): Promise<DeactivationResult> {
    return this.withScopeLock(input.scope, async () => {
      if (input.idempotencyKey) {
        const replayed = this.store.idempotent(input.idempotencyKey);

        if (replayed && replayed.kind === 'deactivated') {
          return { scope: replayed.scope, generation: replayed.generation, active: false };
        }
      }

      this.assertGeneration(input.scope, input.expectedGeneration);

      const previous = this.store.status(input.scope);
      const generation = previous.generation + 1;

      await this.store.append(
        this.event('deactivated', {
          scope: input.scope,
          generation,
          previousGeneration: previous.generation,
          ...(previous.revision !== undefined ? { previousRevision: previous.revision } : {}),
          ...(input.actor !== undefined ? { actor: input.actor } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        }),
      );

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
