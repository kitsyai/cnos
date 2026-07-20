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

    Subscribe(call: grpc.ServerWritableStream<WireSubscribeRequest, WireSnapshotBatch>): void {
      const scopes = call.request.scopes ?? [];
      const token = bearerFromMetadata(call.metadata);

      void (async () => {
        const permitted = await authorize({
          kind: 'read',
          ...(scopes[0] ? { scope: scopes[0] } : {}),
          ...(token !== undefined ? { token } : {}),
        });

        if (!permitted) {
          // `call.destroy(status)` tears the stream down LOCALLY without ever putting a
          // status on the wire — the client sees no data, no error and no end, and hangs for
          // the process lifetime. Emitting 'error' is grpc-js's supported way to terminate a
          // server stream with a status the client can actually observe and classify.
          endWithStatus(call, grpc.status.UNAUTHENTICATED, 'Not authorized for this var scope.');
          return;
        }

        const unsubscribe = engine.onCommit(({ scope, kind, head }) => {
          if (!scopes.some((subscribed) => scopeMatches(subscribed, scope))) {
            return;
          }

          try {
            if (kind === 'deactivated' || !head) {
              call.write(noHeadMessage(scope));
            } else {
              call.write(headMessage(head));
            }
          } catch {
            /* a write on a torn-down stream is a no-op; cleanup runs via the close handlers */
          }
        });

        const cleanup = (): void => unsubscribe();
        call.on('cancelled', cleanup);
        call.on('close', cleanup);
        call.on('error', cleanup);
      })().catch((error: unknown) => {
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
