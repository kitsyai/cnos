import type { ValidationIssue } from '@kitsy/cnos-core';

/** Base class for all var-server control-plane errors. */
export class CnosVarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown by `activate`/`deactivate`/`rollback` when the caller's `expectedGeneration`
 * does not match the scope's current generation (optimistic concurrency conflict).
 */
export class CnosVarConflictError extends CnosVarError {
  readonly code = 'revision-conflict';

  constructor(
    readonly scope: string,
    readonly expectedGeneration: number,
    readonly currentGeneration: number,
  ) {
    super(
      `Generation conflict on var scope "${scope}": expected generation ${expectedGeneration} but the scope is at ${currentGeneration}. ` +
        `Re-read status and retry with --expect-generation ${currentGeneration}.`,
    );
  }
}

/** Thrown when a candidate revision fails whole-document validation at create time. */
export class CnosVarValidationError extends CnosVarError {
  readonly code = 'revision-invalid';

  constructor(
    readonly scope: string,
    readonly issues: ValidationIssue[],
  ) {
    super(
      `Revision for var scope "${scope}" failed validation: ` +
        `${issues.map((issue) => `${issue.code}: ${issue.message}`).join('; ')}. ` +
        `The last-known-good revision is untouched.`,
    );
  }
}

/** Thrown when a referenced revision or scope does not exist in the store. */
export class CnosVarNotFoundError extends CnosVarError {
  readonly code = 'not-found';

  constructor(message: string) {
    super(message);
  }
}

/** Thrown when an operation is unsupported by the active store (e.g. replay on an ephemeral store). */
export class CnosVarStoreError extends CnosVarError {
  readonly code = 'store-unsupported';

  constructor(message: string) {
    super(message);
  }
}
