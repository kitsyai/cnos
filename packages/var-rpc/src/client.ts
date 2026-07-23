import * as grpc from '@grpc/grpc-js';

import {
  CnosVarNoHeadError,
  CnosVarNotModifiedError,
  type ProjectedVarSourceDefinition,
  type VarPullOptions,
  type VarPushEvent,
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

/**
 * Consecutive failed Subscribe attempts after which the subscription becomes TERMINAL.
 * Bounds the reconnect loop so a permanently broken endpoint stops burning connections and
 * starts reporting instead. Identical constant in the Go provider (`maxConsecutiveFailures`).
 */
export const MAX_CONSECUTIVE_SUBSCRIBE_FAILURES = 8;

/**
 * gRPC statuses that are NEVER retried: the server has authoritatively refused this identity,
 * and reconnecting with the same credentials can only repeat the refusal. Canonical policy,
 * identical in the Go provider.
 */
const TERMINAL_STATUSES: ReadonlySet<number> = new Set([
  grpc.status.UNAUTHENTICATED,
  grpc.status.PERMISSION_DENIED,
]);

function isTerminalStatus(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'number' && TERMINAL_STATUSES.has(code);
}

function nextBackoff(attempt: number): number {
  const capped = Math.min(DEFAULT_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return capped / 2 + Math.random() * (capped / 2);
}

export interface RpcVarProviderOptions {
  /**
   * Called for every background subscription failure, terminal or not. A terminal failure
   * means the provider has stopped reconnecting. The provider never throws out of a stream.
   */
  onError?: (error: Error, info: { terminal: boolean; scopes: string[] }) => void;
}

/**
 * The wire carries `generation` as an exact decimal string (`longs: String`). A JS number is
 * exact only to `Number.MAX_SAFE_INTEGER`, so converting a larger value silently corrupts it.
 * Detect that here — at the one edge that still holds the exact text — and fail loudly.
 * (Go carries the same field as a native int64 and round-trips it exactly.)
 */
function toGeneration(raw: string | number): number {
  const value = typeof raw === 'string' ? Number(raw) : raw;

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `Var rpc batch carries generation ${String(raw)}, which is outside the exactly ` +
        `representable range 0..${Number.MAX_SAFE_INTEGER} for this SDK. ` +
        'Configure the var authority to allocate generations below 2^53.',
    );
  }

  return value;
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
    generation: toGeneration(msg.generation),
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
  options: RpcVarProviderOptions = {},
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

  async function pull(scope: VarScope, knownRevision?: string, options?: VarPullOptions): Promise<VarSnapshotBatch> {
    const value = scopeValue(scope);
    const metadata = await authMetadata();
    const signal = options?.signal;

    if (signal?.aborted) {
      throw new DOMException('The var pull was aborted.', 'AbortError');
    }

    const msg = await new Promise<WireSnapshotBatch>((resolve, reject) => {
      const call = (client as unknown as {
        Pull: (
          req: { scope: string; known_revision: string },
          md: grpc.Metadata,
          cb: (err: grpc.ServiceError | null, res?: WireSnapshotBatch) => void,
        ) => grpc.ClientUnaryCall;
      }).Pull({ scope: value, known_revision: knownRevision ?? '' }, metadata, (err, res) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(res as WireSnapshotBatch);
      });

      // Map an abort (close() racing an in-flight startup) onto cancelling the underlying gRPC
      // call, so the network wait ends promptly rather than blocking close() until a timeout.
      if (signal) {
        const onAbort = (): void => {
          call.cancel();
          reject(new DOMException('The var pull was aborted.', 'AbortError'));
        };

        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    if (msg.not_modified) {
      throw new CnosVarNotModifiedError(value, knownRevision ?? '');
    }

    if (msg.no_head) {
      throw new CnosVarNoHeadError(value);
    }

    return toBatch(msg);
  }

  /**
   * Canonical Subscribe failure policy (identical in the Go provider):
   *
   * - `UNAUTHENTICATED` / `PERMISSION_DENIED` are TERMINAL — never reconnected.
   * - Transport/network failures are retryable with capped exponential backoff + jitter, but
   *   bounded: after {@link MAX_CONSECUTIVE_SUBSCRIBE_FAILURES} consecutive failures the
   *   subscription becomes terminal too. A stream that delivered a batch resets the counter.
   * - Every failure is REPORTED (provider `onError` + the SDK's `onSubscriptionError` seam,
   *   which surfaces it in `varStatus()`); nothing ever fails silently, and nothing is ever
   *   thrown out of a background stream.
   *
   * A terminal subscription deliberately does NOT fall back to polling: the same credentials
   * would be refused by `Pull`, and a silent poll loop would hide the failure the terminal
   * state exists to advertise. Consumers observe `subscription.state === 'failed'` and may
   * call `refreshVar()` explicitly.
   */
  function subscribe(scopes: VarScope[], onEvent: (event: VarPushEvent) => void): () => void {
    const scopeStrings = scopes.map(scopeValue);
    let cancelled = false;
    // False only for the very first connect of this subscription; every later connect is a
    // RECONNECT and must trigger a full resync, because the server forwards future commits
    // only and anything that happened during the outage is otherwise lost for good.
    let everConnected = false;
    let current: grpc.ClientReadableStream<WireSnapshotBatch> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const report = (error: unknown, terminal: boolean): void => {
      const err = error instanceof Error ? error : new Error(String(error));
      const info = { terminal, scopes: scopeStrings };

      try {
        options.onError?.(err, info);
      } catch {
        /* a reporting hook must never break the transport */
      }

      try {
        ctx.onSubscriptionError?.(err, info);
      } catch {
        /* ditto */
      }
    };

    /** Classify a stream failure and either schedule a bounded retry or go terminal. */
    const fail = (error: unknown, attempt: number): void => {
      if (cancelled || closed) {
        return;
      }

      const consecutive = attempt + 1;

      if (isTerminalStatus(error) || consecutive >= MAX_CONSECUTIVE_SUBSCRIBE_FAILURES) {
        cancelled = true;
        report(error, true);
        return;
      }

      report(error, false);
      reconnectTimer = setTimeout(() => connect(consecutive), nextBackoff(attempt));

      if (typeof reconnectTimer.unref === 'function') {
        reconnectTimer.unref();
      }
    };

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

          // ORDERING BARRIER: the Subscribe call is on the wire before the SDK issues its
          // resync pulls, so a commit racing the pull is delivered on this stream rather than
          // being dropped. Which of the two wins is then decided by the store's scope epoch.
          const reconnect = everConnected;
          everConnected = true;

          try {
            ctx.onSubscriptionConnected?.(scopeStrings, { reconnect });
          } catch {
            /* a resync hook must never break the transport */
          }

          let delivered = false;
          let settled = false;

          stream.on('data', (msg: WireSnapshotBatch) => {
            // A no-change ack carries nothing to apply — the cached snapshot already IS the head.
            if (msg.not_modified) {
              return;
            }

            // A no_head push is a DEACTIVATION: the authority states the scope has no active
            // head. It must be forwarded, not dropped. An rpc source normally runs no poller, so
            // dropping it left the consumer serving a deactivated revision forever with no pull
            // to converge on. It also counts as a delivery: the stream is demonstrably healthy.
            if (msg.no_head) {
              delivered = true;
              const scope = msg.scope || scopeStrings[0];

              if (scope) {
                try {
                  // W12 safe polarity: omitted/false is the legacy cascading deactivation;
                  // reconstruction opts into exact-scope removal explicitly.
                  onEvent({ kind: 'no-head', scope, exactScope: msg.exact_scope === true });
                } catch {
                  /* a downstream ingest error never tears down the subscription */
                }
              }

              return;
            }

            let batch: VarSnapshotBatch;

            try {
              batch = toBatch(msg);
            } catch (error) {
              // A malformed/unrepresentable batch (e.g. an out-of-range int64 generation) is
              // reported and dropped — never committed, never fatal to the stream.
              report(error, false);
              return;
            }

            delivered = true;

            try {
              onEvent({ kind: 'batch', ...(msg.scope ? { scope: msg.scope } : {}), batch });
            } catch {
              /* a downstream ingest error never tears down the subscription */
            }
          });

          const settle = (error: unknown): void => {
            if (settled) {
              return;
            }

            settled = true;
            activeCalls.delete(stream as grpc.ClientReadableStream<unknown>);
            // A stream that delivered at least one batch was healthy: restart the ramp.
            fail(error, delivered ? 0 : attempt);
          };

          stream.on('error', (error: unknown) => settle(error));
          stream.on('end', () => settle(new Error('Var rpc Subscribe stream ended.')));
          // A server-side `call.destroy(status)` on a stream that never produced data closes
          // the call by delivering a non-OK STATUS — with no 'error' and no 'end' event. That
          // is exactly the auth-rejection path, and listening only for error/end is what made
          // an UNAUTHENTICATED Subscribe die silently.
          stream.on('status', (streamStatus: grpc.StatusObject) => {
            if (streamStatus.code === grpc.status.OK) {
              return;
            }

            const error = new Error(
              streamStatus.details || `Var rpc Subscribe failed with gRPC status ${streamStatus.code}.`,
            );
            settle(Object.assign(error, { code: streamStatus.code }));
          });
        })
        .catch((error: unknown) => fail(error, attempt));
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
  create: (def, ctx) => createRpcVarProvider(def, ctx),
};

/**
 * The same module with provider options applied — use it to attach an `onError` hook to every
 * rpc source's background subscription.
 */
export function createRpcVarSourceProvider(options: RpcVarProviderOptions): VarSourceProviderModule {
  return {
    transport: 'rpc',
    create: (def, ctx) => createRpcVarProvider(def, ctx, options),
  };
}
