/**
 * What a request is asking to do:
 *
 * - `read`   — the data plane (`GET {base}`): the active head for one scope.
 * - `audit`  — the admin READ plane (`GET {base}/admin/status|history|replay`): the append-only
 *              log, including actors, reasons and past document bodies. Strictly more
 *              sensitive than `read`, so it is its own kind and can be denied separately.
 * - `mutate` — the admin WRITE plane (`POST {base}/admin/*`).
 */
export type VarAuthKind = 'read' | 'audit' | 'mutate';

/** Context handed to the pluggable authorization hook for every request. */
export interface VarAuthContext {
  kind: VarAuthKind;
  /**
   * Scope the request targets, when known. Present for reads/audits (from the `key`/`group`/
   * `scope` query parameter) AND for mutations (read from the request body's `scope` field
   * before authorization runs), so scoped authorization applies uniformly to both planes.
   */
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
      'cnos-var-server: no authorize hook configured — allowing ALL var reads, audit reads and ' +
        'mutations. Configure options.authorize (or staticBearerAuthorize) before exposing this server.\n',
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
 * It does not distinguish `read`/`audit`/`mutate` — a holder of a valid token may do all
 * three. Supply your own hook to separate the audit plane from the data plane.
 */
export function staticBearerAuthorize(tokens: string | string[]): VarAuthorize {
  const allowed = new Set(Array.isArray(tokens) ? tokens : [tokens]);
  return (ctx) => (ctx.token !== undefined && allowed.has(ctx.token) ? true : false);
}
