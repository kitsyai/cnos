import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type * as http from 'node:http';

import type { IngestResult, NormalizedVarSourceDefinition, VarSnapshotBatch } from '@kitsy/cnos-core';

type IncomingMessage = http.IncomingMessage;
type ServerResponse = http.ServerResponse;

import { getSingletonRuntime } from './runtime/state.js';

/**
 * Internal hooks the core runtime exposes (non-enumerable) when a var runtime is active.
 * The receiver reaches them through the singleton — never a direct store dependency.
 */
interface VarRuntimeHooks {
  __ingestVar?: (sourceId: string, scope: string, batch: VarSnapshotBatch) => IngestResult | void;
  __varSource?: (sourceId: string) => NormalizedVarSourceDefinition | undefined;
  __resolveVarSecret?: (ref: string) => Promise<string>;
}

/** Default inbound push body cap. Matches the Go receiver's `maxVarReceiverBody`. */
export const DEFAULT_MAX_VAR_BODY_BYTES = 1024 * 1024;

export interface VarReceiverOptions {
  /**
   * Header carrying the signature of the raw request body, formatted as
   * `sha256=<hex hmac-sha256>` (the `sha256=` prefix is REQUIRED). Defaults to
   * `x-cnos-signature`. Presence decides the scheme: when the header is present the body is
   * verified by HMAC and the bearer fallback is NOT consulted; when it is absent the
   * `Authorization: Bearer` token is compared against the source's `verify` secret.
   * Identical rule in the Go SDK receiver.
   */
  signatureHeader?: string;
  /**
   * Maximum accepted request body in bytes. A larger body is rejected with `413`
   * (`payload-too-large`) and the stream is destroyed rather than buffered.
   * Defaults to {@link DEFAULT_MAX_VAR_BODY_BYTES} (1 MiB), matching the Go receiver.
   */
  maxBodyBytes?: number;
  /** Called for a rejected/failed receive; defaults to a stderr warning. */
  onError?: (error: Error) => void;
}

/** Internal sentinel: the inbound body exceeded the configured cap. */
class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Var push body exceeds the ${limit}-byte receiver limit.`);
    this.name = 'BodyTooLargeError';
  }
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

/**
 * Drain the request body, aborting as soon as the accumulated bytes exceed `limit`. The
 * over-limit stream is destroyed instead of being read to completion, so an oversized (or
 * endless) push never becomes a memory-exhaustion vector on a public mount.
 */
async function readRawBody(req: IncomingMessage, limit: number): Promise<string> {
  const preParsed = (req as IncomingMessage & { body?: unknown }).body;

  if (preParsed !== undefined && preParsed !== null && typeof preParsed === 'object') {
    const serialized = JSON.stringify(preParsed);

    if (Buffer.byteLength(serialized, 'utf8') > limit) {
      throw new BodyTooLargeError(limit);
    }

    return serialized;
  }

  // Async-iterable-only sources (express-style doubles, non-http streams) have no event
  // API — read them with `for await`, still bounded.
  if (typeof req.on !== 'function') {
    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      total += buffer.length;

      if (total > limit) {
        throw new BodyTooLargeError(limit);
      }

      chunks.push(buffer);
    }

    return Buffer.concat(chunks).toString('utf8');
  }

  // Event-driven rather than `for await`: exiting a `for await` loop early destroys the
  // request stream, which resets the connection before the 413 can be written. Pausing stops
  // the buffering just as promptly while leaving the response path intact.
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      fn();
    };

    function onData(chunk: Buffer): void {
      total += chunk.length;

      if (total > limit) {
        req.pause();
        finish(() => reject(new BodyTooLargeError(limit)));
        return;
      }

      chunks.push(chunk);
    }

    function onEnd(): void {
      finish(() => resolve(Buffer.concat(chunks).toString('utf8')));
    }

    function onError(error: Error): void {
      finish(() => reject(error));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * A generic, latching push receiver for a single var source. It never starts a server — it
 * returns a Node handler that verifies the source's `verify` secret (bearer or HMAC), then routes
 * the inbound `{ revision?, generation?, values }` payload (scoped by the URL's trailing segment)
 * through the SAME validated ingest path as pull/refresh. Mount it on your own http/express server.
 */
export function varReceiver(sourceId: string, options: VarReceiverOptions = {}): VarReceiverHandler {
  const signatureHeader = (options.signatureHeader ?? 'x-cnos-signature').toLowerCase();
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_VAR_BODY_BYTES;
  const onError = options.onError ?? ((error: Error) => console.warn(`[cnos:var] receiver: ${error.message}`));

  return (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      onError(err);

      if (res.headersSent) {
        return;
      }

      if (err instanceof BodyTooLargeError) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, code: 'payload-too-large' }));
        return;
      }

      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, code: 'internal' }));
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

    const raw = await readRawBody(req, maxBodyBytes);
    const source = runtime.__varSource(sourceId);

    if (!source) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `No var source "${sourceId}" is declared in the manifest; declare it under varSources or unmount this receiver.`,
          code: 'unknown-source',
        }),
      );
      return;
    }

    // FAIL CLOSED. A receiver is an inbound write path, so an undeclared `verify` secret is a
    // misconfiguration, never an invitation to accept unauthenticated pushes. Matches the Go
    // receiver, which 401s the same case.
    const unauthorized = (): void => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Var push signature verification failed.', code: 'unauthorized' }));
    };

    if (!source.verify || !runtime.__resolveVarSecret) {
      onError(
        new Error(
          `Var source "${sourceId}" declares no \`verify\` secret; rejecting the push. ` +
            `Add \`verify: secret.<...>\` to varSources.${sourceId} in the manifest.`,
        ),
      );
      unauthorized();
      return;
    }

    const secret = await runtime.__resolveVarSecret(source.verify);
    const signature = req.headers[signatureHeader];
    let verified = false;

    // Presence-based scheme selection: a signature header present means the signature decides,
    // full stop (a wrong signature is a 401 even alongside a valid bearer). Absent, the bearer
    // token decides. One rule, no silent either-or acceptance. Identical in the Go receiver.
    if (typeof signature === 'string') {
      // `x-cnos-signature: sha256=<hex hmac-sha256 of raw body>` — prefix required.
      const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
      verified = safeEqual(signature, expected);
    } else {
      const token = bearer(req);
      verified = token !== undefined && secret.length > 0 && safeEqual(token, secret);
    }

    if (!verified) {
      unauthorized();
      return;
    }

    let payload: {
      revision?: unknown;
      generation?: unknown;
      schemaId?: unknown;
      effectiveAt?: unknown;
      values?: unknown;
    };

    try {
      payload = raw.trim() ? (JSON.parse(raw) as typeof payload) : {};
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body.', code: 'bad-request' }));
      return;
    }

    if (!payload.values || typeof payload.values !== 'object' || Array.isArray(payload.values)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Push payload must carry a `values` object.', code: 'bad-request' }));
      return;
    }

    const values = payload.values as Record<string, unknown>;
    // Defaults when absent — identical to the Go SDK receiver:
    //   revision   = `sha256:` of canonical JSON of values
    //   generation = current unix millis
    const batch: VarSnapshotBatch = {
      generation: typeof payload.generation === 'number' ? payload.generation : Date.now(),
      revision: typeof payload.revision === 'string' ? payload.revision : revisionOf(values),
      ...(typeof payload.schemaId === 'string' ? { schemaId: payload.schemaId } : {}),
      effectiveAt:
        typeof payload.effectiveAt === 'string' && payload.effectiveAt
          ? payload.effectiveAt
          : new Date().toISOString(),
      values,
    };

    const result = runtime.__ingestVar(sourceId, scope, batch);

    // A validation-rejected batch keeps last-known-good and reports 422.
    if (result && result.ok === false) {
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'Var push rejected by validation.', code: 'validation-rejected', issues: result.issues ?? [] }),
      );
      return;
    }

    res.writeHead(204);
    res.end();
  }
}
