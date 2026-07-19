/** Context handed to the pluggable authorization hook for every request. */
export interface VarAuthContext {
  kind: 'read' | 'mutate';
  /** Scope key the request targets, when known. */
  scope?: string;
  /** Bearer token extracted from the Authorization header, if present. */
  token?: string;
}

export type VarAuthorize = (ctx: VarAuthContext) => boolean | Promise<boolean>;

let devWarningEmitted = false;

/**
 * Default development authorizer: allows every request and emits a single stderr warning.
 * Real workload-identity authorization arrives in a later phase — do not ship this to
 * production.
 */
export const allowAllWithWarning: VarAuthorize = () => {
  if (!devWarningEmitted) {
    devWarningEmitted = true;
    process.stderr.write(
      'cnos-var-server: no authorize hook configured — allowing ALL var reads and mutations. ' +
        'Configure options.authorize (or staticBearerAuthorize) before exposing this server.\n',
    );
  }

  return true;
};

/** Reset the once-only dev warning latch. Exposed for tests. */
export function resetAuthWarning(): void {
  devWarningEmitted = false;
}

/**
 * Static bearer-token authorizer: permits a request only when its bearer token matches one
 * of the configured tokens. A minimal option for dev/CI until workload identity lands.
 */
export function staticBearerAuthorize(tokens: string | string[]): VarAuthorize {
  const allowed = new Set(Array.isArray(tokens) ? tokens : [tokens]);
  return (ctx) => (ctx.token !== undefined && allowed.has(ctx.token) ? true : false);
}
