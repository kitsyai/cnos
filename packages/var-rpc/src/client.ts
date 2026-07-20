import * as grpc from '@grpc/grpc-js';

import {
  CnosVarNoHeadError,
  CnosVarNotModifiedError,
  type ProjectedVarSourceDefinition,
  type VarScope,
  type VarSnapshotBatch,
  type VarSourceProvider,
  type VarSourceProviderContext,
  type VarSourceProviderModule,
} from '@kitsy/cnos-core';

import {
  varServiceClientConstructor,
  type WireSnapshotBatch,
  type WireSubscribeRequest,
} from './proto.js';

/** Mirror of the http/poller backoff policy: capped exponential with half-jitter. */
const DEFAULT_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

function nextBackoff(attempt: number): number {
  const capped = Math.min(DEFAULT_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return capped / 2 + Math.random() * (capped / 2);
}

/** Strip a URL scheme so the manifest `url` maps onto a bare gRPC `host:port` target. */
function grpcTarget(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
}

function scopeValue(scope: VarScope): string {
  const value = scope.key ?? scope.group;

  if (value === undefined) {
    throw new Error('VarScope must specify either a key or a group.');
  }

  return value;
}

function toBatch(msg: WireSnapshotBatch): VarSnapshotBatch {
  const raw = msg.values_json;
  const text = raw && raw.length ? Buffer.from(raw).toString('utf8') : '';
  const values = (text ? JSON.parse(text) : {}) as Record<string, unknown>;

  return {
    generation: typeof msg.generation === 'string' ? Number(msg.generation) : msg.generation,
    revision: msg.revision,
    ...(msg.schema_id ? { schemaId: msg.schema_id } : {}),
    effectiveAt: msg.effective_at || new Date().toISOString(),
    values,
  };
}

/**
 * The rpc (gRPC) {@link VarSourceProvider}. Speaks `cnos.var.v1.VarService` over a
 * `@grpc/grpc-js` channel: `Pull` maps `not_modified` → keep-cache (like http 304) and
 * `no_head` → overlay fallback (like http 404 no-head); `Subscribe` opens a server-stream
 * feeding accepted activations into the SDK ingest path, reconnecting with the same capped
 * backoff+jitter policy as the pollers. Bearer auth rides gRPC metadata, resolved from the
 * source's `secret.*` ref at call time.
 */
export function createRpcVarProvider(
  def: ProjectedVarSourceDefinition,
  ctx: VarSourceProviderContext,
): VarSourceProvider {
  const target = grpcTarget(def.url);
  const bearerRef = def.auth?.bearer;
  const client = new (varServiceClientConstructor())(target, grpc.credentials.createInsecure());

  let closed = false;
  const activeCalls = new Set<grpc.ClientReadableStream<unknown>>();

  async function authMetadata(): Promise<grpc.Metadata> {
    const metadata = new grpc.Metadata();

    if (bearerRef) {
      const token = await ctx.resolveSecret(bearerRef);
      metadata.set('authorization', `Bearer ${token}`);
    }

    return metadata;
  }

  async function pull(scope: VarScope, knownRevision?: string): Promise<VarSnapshotBatch> {
    const value = scopeValue(scope);
    const metadata = await authMetadata();

    const msg = await new Promise<WireSnapshotBatch>((resolve, reject) => {
      (client as unknown as {
        Pull: (
          req: { scope: string; known_revision: string },
          md: grpc.Metadata,
          cb: (err: grpc.ServiceError | null, res?: WireSnapshotBatch) => void,
        ) => void;
      }).Pull({ scope: value, known_revision: knownRevision ?? '' }, metadata, (err, res) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(res as WireSnapshotBatch);
      });
    });

    if (msg.not_modified) {
      throw new CnosVarNotModifiedError(value, knownRevision ?? '');
    }

    if (msg.no_head) {
      throw new CnosVarNoHeadError(value);
    }

    return toBatch(msg);
  }

  function subscribe(scopes: VarScope[], onBatch: (batch: VarSnapshotBatch) => void): () => void {
    const scopeStrings = scopes.map(scopeValue);
    let cancelled = false;
    let current: grpc.ClientReadableStream<WireSnapshotBatch> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = (attempt: number): void => {
      if (cancelled || closed) {
        return;
      }

      void authMetadata()
        .then((metadata) => {
          if (cancelled || closed) {
            return;
          }

          const request: WireSubscribeRequest = { scopes: scopeStrings };
          const stream = (client as unknown as {
            Subscribe: (
              req: WireSubscribeRequest,
              md: grpc.Metadata,
            ) => grpc.ClientReadableStream<WireSnapshotBatch>;
          }).Subscribe(request, metadata);

          current = stream;
          activeCalls.add(stream as grpc.ClientReadableStream<unknown>);

          stream.on('data', (msg: WireSnapshotBatch) => {
            // Push-based deactivations (no_head) and no-change acks are not ingestable batches;
            // the SDK converges on the next pull. Only forward concrete head batches.
            if (msg.not_modified || msg.no_head) {
              return;
            }

            try {
              onBatch(toBatch(msg));
            } catch {
              /* a downstream ingest error never tears down the subscription */
            }
          });

          const scheduleReconnect = (): void => {
            activeCalls.delete(stream as grpc.ClientReadableStream<unknown>);

            if (cancelled || closed) {
              return;
            }

            reconnectTimer = setTimeout(() => connect(attempt + 1), nextBackoff(attempt));

            if (typeof reconnectTimer.unref === 'function') {
              reconnectTimer.unref();
            }
          };

          stream.on('error', scheduleReconnect);
          stream.on('end', scheduleReconnect);
        })
        .catch(() => {
          if (cancelled || closed) {
            return;
          }

          reconnectTimer = setTimeout(() => connect(attempt + 1), nextBackoff(attempt));

          if (typeof reconnectTimer.unref === 'function') {
            reconnectTimer.unref();
          }
        });
    };

    connect(0);

    return () => {
      cancelled = true;

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }

      if (current) {
        current.cancel();
        activeCalls.delete(current as grpc.ClientReadableStream<unknown>);
      }
    };
  }

  return {
    pull,
    subscribe,
    async close(): Promise<void> {
      closed = true;

      for (const call of activeCalls) {
        call.cancel();
      }

      activeCalls.clear();
      client.close();
    },
  };
}

/** The transport-keyed module, registered like a secret vault provider factory. */
export const rpcVarSourceProvider: VarSourceProviderModule = {
  transport: 'rpc',
  create: createRpcVarProvider,
};
