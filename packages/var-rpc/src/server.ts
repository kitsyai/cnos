import * as grpc from '@grpc/grpc-js';

import type { DocumentSchemaDefinition } from '@kitsy/cnos-core';
import {
  allowAllWithWarning,
  createVarEngine,
  type ScopeHead,
  type VarAuthorize,
  type VarEngine,
  type VarStore,
} from '@kitsy/cnos-var-server';

import { varServiceDefinition, type WirePullRequest, type WireSnapshotBatch, type WireSubscribeRequest } from './proto.js';

export interface VarRpcServerOptions {
  /** Document schemas for the engine when one is not supplied. */
  documents?: Record<string, DocumentSchemaDefinition>;
  /** Clock override for a created engine (deterministic tests). */
  clock?: () => string;
  /** Pluggable authorization hook; reused verbatim from var-server. Defaults to allow-all + warning. */
  authorize?: VarAuthorize;
  /**
   * The mutation engine whose commit path feeds Subscribe. Pass the SAME engine the http
   * admin plane / CLI mutates through so activations reach rpc subscribers. When omitted a
   * fresh engine is created over `store` (Subscribe then only sees mutations via THAT engine).
   */
  engine?: VarEngine;
}

function bearerFromMetadata(metadata: grpc.Metadata): string | undefined {
  const header = metadata.get('authorization')[0];

  if (typeof header !== 'string') {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : undefined;
}

const EMPTY_VALUES = Buffer.alloc(0);
const MAX_PENDING_SUBSCRIBE_EVENTS = 1024;

/** Canonical head batch — the SAME `{generation, revision, schemaId?, effectiveAt, values}` the http route serves. */
function headMessage(head: ScopeHead): WireSnapshotBatch {
  return {
    scope: head.scope,
    generation: String(head.generation),
    revision: head.revision,
    schema_id: head.schemaId ?? '',
    effective_at: head.effectiveAt,
    values_json: Buffer.from(JSON.stringify(head.values), 'utf8'),
    not_modified: false,
    no_head: false,
  };
}

function notModifiedMessage(scope: string, head: ScopeHead): WireSnapshotBatch {
  return {
    scope,
    generation: String(head.generation),
    revision: head.revision,
    schema_id: '',
    effective_at: '',
    values_json: EMPTY_VALUES,
    not_modified: true,
    no_head: false,
  };
}

function noHeadMessage(scope: string): WireSnapshotBatch {
  return {
    scope,
    generation: '0',
    revision: '',
    schema_id: '',
    effective_at: '',
    values_json: EMPTY_VALUES,
    not_modified: false,
    no_head: true,
  };
}

/**
 * Terminate a server stream with a gRPC status the CLIENT can observe. grpc-js delivers a
 * status for a server-streaming call through an emitted `error`; `call.destroy(status)` only
 * tears down the local call object, which is why an auth-rejected Subscribe used to leave the
 * client silently hanging (W5d/D1).
 */
function endWithStatus(
  call: grpc.ServerWritableStream<WireSubscribeRequest, WireSnapshotBatch>,
  code: grpc.status,
  details: string,
): void {
  call.emit('error', Object.assign(new Error(details), { code, details }) as grpc.ServiceError);
}

/** Whether an activation/deactivation on `committedScope` matches a subscribed scope string. */
function scopeMatches(subscribed: string, committedScope: string): boolean {
  return committedScope === subscribed || committedScope.startsWith(`${subscribed}.`);
}

/**
 * Register `cnos.var.v1.VarService` on a caller-provided `@grpc/grpc-js` Server (library-first:
 * embeddable onto an existing gRPC listener, mirroring `varServer(store)` — it never creates
 * its own server). Reads (`Pull`) come straight from `store.head` — the exact canonical batch
 * the http route serves. `Subscribe` hooks the engine commit path and pushes the new batch to
 * matching subscribers on every accepted activation/deactivation.
 */
export function attachVarRpc(server: grpc.Server, store: VarStore, options: VarRpcServerOptions = {}): void {
  const authorize = options.authorize ?? allowAllWithWarning;
  const engine =
    options.engine ??
    createVarEngine(store, {
      ...(options.documents ? { documents: options.documents } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    });

  const handlers = {
    Pull(
      call: grpc.ServerUnaryCall<WirePullRequest, WireSnapshotBatch>,
      callback: grpc.sendUnaryData<WireSnapshotBatch>,
    ): void {
      void (async () => {
        const scope = call.request.scope;
        const knownRevision = call.request.known_revision;
        const token = bearerFromMetadata(call.metadata);

        const permitted = await authorize({
          kind: 'read',
          ...(scope ? { scope } : {}),
          ...(token !== undefined ? { token } : {}),
        });

        if (call.cancelled) {
          return;
        }

        if (!permitted) {
          callback({ code: grpc.status.UNAUTHENTICATED, details: 'Not authorized for this var scope.' });
          return;
        }

        const head = store.head(scope);

        if (!head) {
          callback(null, noHeadMessage(scope));
          return;
        }

        if (knownRevision && knownRevision === head.revision) {
          callback(null, notModifiedMessage(scope, head));
          return;
        }

        callback(null, headMessage(head));
      })().catch((error: unknown) => {
        callback({
          code: grpc.status.INTERNAL,
          details: error instanceof Error ? error.message : String(error),
        });
      });
    },

    /**
     * SELF-SYNCHRONIZING SUBSCRIBE (round-3 follow-up).
     *
     * Two properties, both required for a subscriber to converge without depending on a race:
     *
     * 1. The commit listener is registered SYNCHRONOUSLY, at handler entry, BEFORE the
     *    `await authorize(...)`. Registering it after the await left a window — from the
     *    Subscribe request landing to the hook existing — in which a commit was delivered by
     *    neither the stream (no hook yet) nor the client's reconnect resync pull (which may
     *    have been issued just before that commit). Commits arriving while authorization is
     *    still resolving are BUFFERED, then flushed in commit order once it succeeds. A failed
     *    authorization discards the buffer and terminates the stream exactly as before.
     * 2. An accepted Subscribe emits the CURRENT STATE as its first event(s): an authored exact
     *    head/tombstone plus every known matching descendant, parent first. A never-authored
     *    parent no-head is suppressed when active descendants exist, avoiding a false cascading
     *    fallback before those child heads are restored.
     *
     * Every requested scope is authorized before any buffered event is written. The pending
     * buffer is bounded to prevent a stalled authorizer from creating unbounded memory growth.
     * Initial state is deduplicated against the flushed buffer by revision, so a client
     * never observes the same revision twice in a row. Everything from the flush through
     * `authorized = true` runs in one synchronous block, and `engine.emitCommit` is itself
     * synchronous, so no commit can interleave between the buffer flush and the live path.
     */
    Subscribe(call: grpc.ServerWritableStream<WireSubscribeRequest, WireSnapshotBatch>): void {
      const scopes = call.request.scopes ?? [];
      const token = bearerFromMetadata(call.metadata);

      /** Commits observed while `authorize` is still pending, in commit order. */
      const buffered: WireSnapshotBatch[] = [];
      /** Flipped once authorization succeeded and the buffer has been flushed. */
      let authorized = false;
      /** Flipped when the call is cancelled/closed/errored, or auth was refused. */
      let torn = false;
      /** Last emitted identity per scope — `revision`, or a sentinel for `no_head`. */
      const lastEmitted = new Map<string, string>();

      const identity = (msg: WireSnapshotBatch): string => (msg.no_head ? '\u0000no-head' : msg.revision);

      const emit = (msg: WireSnapshotBatch): void => {
        if (torn) {
          return;
        }

        if (msg.no_head) {
          for (const scope of lastEmitted.keys()) {
            if (scope.startsWith(`${msg.scope}.`)) {
              lastEmitted.delete(scope);
            }
          }
        }

        lastEmitted.set(msg.scope, identity(msg));

        try {
          call.write(msg);
        } catch {
          /* a write on a torn-down stream is a no-op; cleanup runs via the close handlers */
        }
      };

      // Registered SYNCHRONOUSLY — before the authorize await — so the commit path cannot slip
      // through the gap between the Subscribe request and the hook existing.
      const unsubscribe = engine.onCommit(({ scope, kind, head }) => {
        if (!scopes.some((subscribed) => scopeMatches(subscribed, scope))) {
          return;
        }

        const msg = kind === 'deactivated' || !head ? noHeadMessage(scope) : headMessage(head);

        if (!authorized) {
          // Authorization is still resolving: hold the commit rather than writing to a stream
          // that may yet be refused, and rather than dropping it.
          if (buffered.length >= MAX_PENDING_SUBSCRIBE_EVENTS) {
            cleanup();
            endWithStatus(
              call,
              grpc.status.RESOURCE_EXHAUSTED,
              `Subscribe authorization exceeded the ${MAX_PENDING_SUBSCRIBE_EVENTS}-event pending buffer.`,
            );
            return;
          }

          buffered.push(msg);
          return;
        }

        emit(msg);
      });

      const cleanup = (): void => {
        torn = true;
        buffered.length = 0;
        unsubscribe();
      };

      call.on('cancelled', cleanup);
      call.on('close', cleanup);
      call.on('error', cleanup);

      void (async () => {
        const authorizationScopes: Array<string | undefined> =
          scopes.length > 0 ? Array.from(new Set(scopes)) : [undefined];
        let permitted = true;

        for (const scope of authorizationScopes) {
          const allowed = await authorize({
            kind: 'read',
            ...(scope ? { scope } : {}),
            ...(token !== undefined ? { token } : {}),
          });

          if (torn) {
            return;
          }

          if (!allowed) {
            permitted = false;
            break;
          }
        }

        if (torn) {
          return;
        }

        if (!permitted) {
          // Buffered commits belong to an identity the server just refused: discard them
          // WITHOUT writing, then terminate. `call.destroy(status)` tears the stream down
          // LOCALLY without ever putting a status on the wire — the client sees no data, no
          // error and no end, and hangs for the process lifetime. Emitting 'error' is
          // grpc-js's supported way to terminate a server stream with an observable status.
          cleanup();
          endWithStatus(call, grpc.status.UNAUTHENTICATED, 'Not authorized for this var scope.');
          return;
        }

        // --- one synchronous block: flush, initial state, go live ---

        for (const msg of buffered) {
          emit(msg);
        }

        buffered.length = 0;

        const initialScopes = new Set<string>();
        const knownScopes = store.scopes();

        for (const requested of scopes) {
          const matching = knownScopes.filter((known) => scopeMatches(requested, known));
          const activeDescendants = matching.filter(
            (known) => known !== requested && store.head(known) !== undefined,
          );
          const requestedHead = store.head(requested);
          const requestedStatus = store.status(requested);

          // A never-authored parent with active children is not a deactivation. A synthetic
          // parent no-head would cascade-delete those children before their heads restored them.
          // An explicit parent tombstone (generation > 0) remains authoritative and cascading.
          if (requestedHead || requestedStatus.generation > 0 || activeDescendants.length === 0) {
            initialScopes.add(requested);
          }

          if (!requestedHead && requestedStatus.generation > 0) {
            continue;
          }

          for (const known of matching) {
            initialScopes.add(known);
          }
        }

        const orderedInitialScopes = Array.from(initialScopes).sort((left, right) => {
          const depth = left.split('.').length - right.split('.').length;
          return depth !== 0 ? depth : left.localeCompare(right);
        });

        for (const scope of orderedInitialScopes) {
          const head = store.head(scope);
          const msg = head ? headMessage(head) : noHeadMessage(scope);

          // `store.head` is read AFTER the buffer, so it already reflects every flushed
          // commit; re-sending an identical revision would only be noise on the wire.
          if (lastEmitted.get(scope) === identity(msg)) {
            continue;
          }

          emit(msg);
        }

        authorized = true;
      })().catch((error: unknown) => {
        cleanup();
        endWithStatus(call, grpc.status.INTERNAL, error instanceof Error ? error.message : String(error));
      });
    },
  };

  server.addService(varServiceDefinition(), handlers as unknown as grpc.UntypedServiceImplementation);
}

export interface ServeVarRpcOptions extends VarRpcServerOptions {
  host?: string;
  /** Port to listen on; `0` (default) picks a random free port. */
  port?: number;
  /** Channel credentials; defaults to insecure (real TLS is a deployment concern). */
  credentials?: grpc.ServerCredentials;
}

export interface RunningVarRpcServer {
  server: grpc.Server;
  host: string;
  port: number;
  /** `host:port` gRPC target the client dials. */
  target: string;
  close(): Promise<void>;
}

/**
 * Thin standalone wrapper: create a fresh `@grpc/grpc-js` Server, attach the var service, and
 * bind it. Backs `cnos var serve --rpc` and the var-rpc test suite. One server implementation
 * total — standalone vs embedded is a packaging choice, exactly like `serveVarServer`.
 */
export async function serveVarRpc(store: VarStore, options: ServeVarRpcOptions = {}): Promise<RunningVarRpcServer> {
  const host = options.host ?? '127.0.0.1';
  const server = new grpc.Server();
  attachVarRpc(server, store, options);

  const credentials = options.credentials ?? grpc.ServerCredentials.createInsecure();

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(`${host}:${options.port ?? 0}`, credentials, (error, boundPort) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(boundPort);
    });
  });

  // grpc-js >=1.10 auto-starts after bindAsync; start() remains a safe no-op on those versions.
  try {
    (server as unknown as { start?: () => void }).start?.();
  } catch {
    /* already started — nothing to do */
  }

  return {
    server,
    host,
    port,
    target: `${host}:${port}`,
    async close() {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };

        server.tryShutdown(finish);

        // `tryShutdown` waits for in-flight calls — an open Subscribe server-stream never
        // completes on its own — so force-shutdown shortly after to cancel streams and free
        // the port (important for restart/reconnect).
        const fallback = setTimeout(() => {
          try {
            server.forceShutdown();
          } catch {
            /* already shut down */
          }
          finish();
        }, 250);

        if (typeof fallback.unref === 'function') {
          fallback.unref();
        }
      });
    },
  };
}
