import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type * as http from 'node:http';

import type { NormalizedVarSourceDefinition, VarSnapshotBatch } from '@kitsy/cnos-core';

type IncomingMessage = http.IncomingMessage;
type ServerResponse = http.ServerResponse;

import { getSingletonRuntime } from './runtime/state.js';

/**
 * Internal hooks the core runtime exposes (non-enumerable) when a var runtime is active.
 * The receiver reaches them through the singleton — never a direct store dependency.
 */
interface VarRuntimeHooks {
  __ingestVar?: (sourceId: string, scope: string, batch: VarSnapshotBatch) => void;
  __varSource?: (sourceId: string) => NormalizedVarSourceDefinition | undefined;
  __resolveVarSecret?: (ref: string) => Promise<string>;
}

export interface VarReceiverOptions {
  /**
   * Header carrying the HMAC-SHA256 hex signature of the raw request body. Defaults to
   * `x-cnos-signature`. When present the body is verified by HMAC; otherwise a bearer token is
   * compared against the source's `verify` secret.
   */
  signatureHeader?: string;
  /** Called for a rejected/failed receive; defaults to a stderr warning. */
  onError?: (error: Error) => void;
}

/** Node-style handler returned by {@link varReceiver}. Works with `http.createServer` and express. */
export type VarReceiverHandler = (req: IncomingMessage, res: ServerResponse) => void;

function scopeFromUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  const pathname = url.split('?')[0] ?? '';
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last ? decodeURIComponent(last) : undefined;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function revisionOf(values: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(values)).digest('hex')}`;
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;

  if (!header) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const preParsed = (req as IncomingMessage & { body?: unknown }).body;

  if (preParsed !== undefined && preParsed !== null && typeof preParsed === 'object') {
    return JSON.stringify(preParsed);
  }

  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A generic, latching push receiver for a single var source. It never starts a server — it
 * returns a Node handler that verifies the source's `verify` secret (bearer or HMAC), then routes
 * the inbound `{ revision?, generation?, values }` payload (scoped by the URL's trailing segment)
 * through the SAME validated ingest path as pull/refresh. Mount it on your own http/express server.
 */
export function varReceiver(sourceId: string, options: VarReceiverOptions = {}): VarReceiverHandler {
  const signatureHeader = (options.signatureHeader ?? 'x-cnos-signature').toLowerCase();
  const onError = options.onError ?? ((error: Error) => console.warn(`[cnos:var] receiver: ${error.message}`));

  return (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      onError(err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, code: 'internal' }));
      }
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Var receiver accepts POST only.', code: 'method-not-allowed' }));
      return;
    }

    const runtime = getSingletonRuntime() as (VarRuntimeHooks | undefined) & { __ingestVar?: unknown };

    if (!runtime?.__ingestVar || !runtime.__varSource) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'CNOS var runtime is not ready.', code: 'not-ready' }));
      return;
    }

    const scope = scopeFromUrl(req.url);

    if (!scope) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Receiver URL must end with a key or group scope.', code: 'bad-request' }));
      return;
    }

    const raw = await readRawBody(req);
    const source = runtime.__varSource(sourceId);

    // Verify the source's `verify` secret when declared.
    if (source?.verify && runtime.__resolveVarSecret) {
      const secret = await runtime.__resolveVarSecret(source.verify);
      const signature = req.headers[signatureHeader];
      let verified = false;

      if (typeof signature === 'string') {
        const expected = createHmac('sha256', secret).update(raw).digest('hex');
        verified = safeEqual(signature, expected);
      } else {
        const token = bearer(req);
        verified = token !== undefined && safeEqual(token, secret);
      }

      if (!verified) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Var push signature verification failed.', code: 'unauthorized' }));
        return;
      }
    }

    let payload: { revision?: unknown; generation?: unknown; values?: unknown };

    try {
      payload = raw.trim() ? (JSON.parse(raw) as typeof payload) : {};
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body.', code: 'bad-request' }));
      return;
    }

    const values = (payload.values && typeof payload.values === 'object'
      ? payload.values
      : {}) as Record<string, unknown>;
    const batch: VarSnapshotBatch = {
      generation: typeof payload.generation === 'number' ? payload.generation : Date.now(),
      revision: typeof payload.revision === 'string' ? payload.revision : revisionOf(values),
      effectiveAt: new Date().toISOString(),
      values,
    };

    runtime.__ingestVar(sourceId, scope, batch);

    res.writeHead(204);
    res.end();
  }
}
