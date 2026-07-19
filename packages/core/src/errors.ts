export class CnosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class CnosManifestError extends CnosError {
  constructor(message: string, readonly manifestPath?: string) {
    super(manifestPath ? `${message} (${manifestPath})` : message);
  }
}

export class CnosDiscoveryError extends CnosError {
  constructor(message: string) {
    super(message);
  }
}

export class CnosSecurityError extends CnosError {
  constructor(message: string) {
    super(message);
  }
}

export class CnosAuthenticationError extends CnosError {
  constructor(message: string) {
    super(message);
  }
}

export class CnosKeyNotFoundError extends CnosError {
  constructor(readonly key: string) {
    super(`Missing required CNOS config key: ${key}`);
  }
}

export class CnosDerivedExpressionError extends CnosError {
  constructor(message: string, readonly expression?: string) {
    super(expression ? `${message} (${expression})` : message);
  }
}

export class CnosDerivedCycleError extends CnosError {
  constructor(message: string) {
    super(message);
  }
}

export class CnosDerivedResolutionError extends CnosError {
  constructor(readonly key: string, message: string) {
    super(message);
  }
}

export class CnosRuntimeProviderError extends CnosError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * A mandatory (`required: true`) `var.*` key could not be resolved through any overlay tier
 * (no runtime revision, no static `value.*`, no default). Thrown on read and surfaced when a
 * prefetch group fails to make a required var available during ready().
 */
export class CnosVarRequiredError extends CnosError {
  constructor(readonly key: string) {
    super(
      `Required runtime variable "${key}" is unresolved: no active runtime revision, static value, or default is available.`,
    );
  }
}

/**
 * A var source reported it has no active runtime head for a scope (http `404 {code:"no-head"}`).
 * Not a failure — the overlay falls back to the static/default tiers. Providers throw this so the
 * store can distinguish "no head" from a transport error.
 */
export class CnosVarNoHeadError extends CnosError {
  constructor(readonly scope: string) {
    super(`Var source has no active runtime head for scope "${scope}".`);
  }
}

/**
 * A var source reported the known revision is still current (http `304 Not Modified`). Providers
 * throw this on a conditional pull so the manager keeps the cached snapshot untouched.
 */
export class CnosVarNotModifiedError extends CnosError {
  constructor(readonly scope: string, readonly revision: string) {
    super(`Var scope "${scope}" is unchanged at revision ${revision}.`);
  }
}
