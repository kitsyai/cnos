import {
  CnosVarNoHeadError,
  CnosVarNotModifiedError,
  type ProjectedVarSourceDefinition,
  type VarPullOptions,
  type VarScope,
  type VarSourceProvider,
  type VarSourceProviderContext,
  type VarSourceProviderModule,
  type VarSnapshotBatch,
} from '@kitsy/cnos-core';

const READ_PATH = '/cnos/vars';

function endpointFor(url: string): string {
  const base = url.replace(/\/+$/, '');
  return base.endsWith(READ_PATH) ? base : `${base}${READ_PATH}`;
}

function scopeQuery(scope: VarScope): { param: 'key' | 'group'; value: string } {
  if (scope.key !== undefined) {
    return { param: 'key', value: scope.key };
  }

  if (scope.group !== undefined) {
    return { param: 'group', value: scope.group };
  }

  throw new Error('VarScope must specify either a key or a group.');
}

function toBatch(scopeValue: string, body: unknown): VarSnapshotBatch {
  if (!body || typeof body !== 'object') {
    throw new Error(`Malformed var response for scope "${scopeValue}": expected a JSON object.`);
  }

  const record = body as Record<string, unknown>;

  if (typeof record.generation !== 'number' || typeof record.revision !== 'string') {
    throw new Error(`Malformed var response for scope "${scopeValue}": missing generation/revision.`);
  }

  return {
    generation: record.generation,
    revision: record.revision,
    ...(typeof record.schemaId === 'string' ? { schemaId: record.schemaId } : {}),
    effectiveAt: typeof record.effectiveAt === 'string' ? record.effectiveAt : new Date().toISOString(),
    values: (record.values && typeof record.values === 'object' ? record.values : {}) as Record<string, unknown>,
  };
}

/**
 * The http {@link VarSourceProvider}: pulls a scope over the CNOS var read protocol using the
 * platform `fetch`, honoring ETag / `If-None-Match` (304 → keep cache) and `404 {code:"no-head"}`
 * (→ overlay fallback). Bearer auth is resolved from the source's `secret.*` ref at call time.
 */
export function createHttpVarProvider(
  def: ProjectedVarSourceDefinition,
  ctx: VarSourceProviderContext,
): VarSourceProvider {
  const endpoint = endpointFor(def.url);
  const bearerRef = def.auth?.bearer;

  async function authHeaders(): Promise<Record<string, string>> {
    if (!bearerRef) {
      return {};
    }

    const token = await ctx.resolveSecret(bearerRef);
    return { authorization: `Bearer ${token}` };
  }

  return {
    async pull(scope: VarScope, knownRevision?: string, options?: VarPullOptions): Promise<VarSnapshotBatch> {
      const { param, value } = scopeQuery(scope);
      const url = `${endpoint}?${param}=${encodeURIComponent(value)}`;
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...(await authHeaders()),
        ...(knownRevision ? { 'if-none-match': knownRevision } : {}),
      };

      // `fetch` honors the AbortSignal natively, so a `close()` racing an in-flight startup
      // aborts the request promptly instead of waiting out the socket timeout.
      const response = await fetch(url, {
        method: 'GET',
        headers,
        ...(options?.signal ? { signal: options.signal } : {}),
      });

      if (response.status === 304) {
        throw new CnosVarNotModifiedError(value, knownRevision ?? '');
      }

      if (response.status === 404) {
        let code: unknown;
        try {
          code = ((await response.json()) as { code?: unknown }).code;
        } catch {
          code = undefined;
        }

        if (code === 'no-head') {
          throw new CnosVarNoHeadError(value);
        }

        throw new Error(`Var source returned 404 for scope "${value}" (${endpoint}).`);
      }

      if (!response.ok) {
        let code: unknown;
        let message: unknown;
        try {
          const body = (await response.json()) as { code?: unknown; error?: unknown };
          code = body.code;
          message = body.error;
        } catch {
          /* ignore parse errors */
        }

        throw new Error(
          `Var source pull for scope "${value}" failed: ${response.status}${
            code ? ` (${String(code)})` : ''
          }${message ? ` ${String(message)}` : ''}.`,
        );
      }

      return toBatch(value, await response.json());
    },
    async close(): Promise<void> {
      /* stateless — nothing to release */
    },
  };
}

/** The transport-keyed module, registered like a secret vault provider factory. */
export const httpVarSourceProvider: VarSourceProviderModule = {
  transport: 'http',
  create: createHttpVarProvider,
};
