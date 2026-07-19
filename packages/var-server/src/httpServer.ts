import type { IncomingMessage, ServerResponse } from 'node:http';

import type { DocumentSchemaDefinition } from '@kitsy/cnos-core';

import { allowAllWithWarning, type VarAuthorize } from './authorize.js';
import { createVarEngine, VarEngine } from './engine.js';
import {
  CnosVarConflictError,
  CnosVarNotFoundError,
  CnosVarStoreError,
  CnosVarValidationError,
} from './errors.js';
import type { VarStore } from './types.js';

export interface VarServerOptions {
  /** Route base. Defaults to `/cnos/vars`. Read plane is `{base}`, mutations `{base}/admin/*`. */
  base?: string;
  /** Document schemas for revision validation, keyed by schemaId. */
  documents?: Record<string, DocumentSchemaDefinition>;
  /** Clock override (ISO timestamp) for deterministic tests. */
  clock?: () => string;
  /** Pluggable authorization hook. Defaults to allow-all with a one-time stderr warning. */
  authorize?: VarAuthorize;
  /** Pre-built engine to share store state/locks with a test harness. */
  engine?: VarEngine;
}

/** Node request handler produced by {@link varServer}: `(req, res) => void`. */
export type VarServerHandler = (req: IncomingMessage, res: ServerResponse) => void;

interface Parsed {
  method: string;
  pathname: string;
  query: URLSearchParams;
}

function parse(req: IncomingMessage, base: string): Parsed | undefined {
  const url = new URL(req.url ?? '/', 'http://var.local');

  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
    return undefined;
  }

  return { method: (req.method ?? 'GET').toUpperCase(), pathname: url.pathname, query: url.searchParams };
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;

  if (!header) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : undefined;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();

  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

function errorStatus(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof CnosVarConflictError) {
    return {
      status: 409,
      body: {
        error: error.message,
        code: error.code,
        expectedGeneration: error.expectedGeneration,
        currentGeneration: error.currentGeneration,
      },
    };
  }

  if (error instanceof CnosVarValidationError) {
    return { status: 422, body: { error: error.message, code: error.code, issues: error.issues } };
  }

  if (error instanceof CnosVarNotFoundError) {
    return { status: 404, body: { error: error.message, code: error.code } };
  }

  if (error instanceof CnosVarStoreError) {
    return { status: 400, body: { error: error.message, code: error.code } };
  }

  if (error instanceof SyntaxError) {
    return { status: 400, body: { error: `Invalid JSON body: ${error.message}`, code: 'bad-request' } };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { error: message, code: 'internal' } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];

  if (typeof value !== 'string' || value.length === 0) {
    throw new CnosVarStoreError(`Missing required field "${field}" in request body.`);
  }

  return value;
}

function requireNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CnosVarStoreError(`Missing required numeric field "${field}" in request body.`);
  }

  return value;
}

/**
 * Build an embeddable Node HTTP handler exposing the CNOS var protocol over `store`.
 * Usable directly with `http.createServer(varServer(store))` and mountable by express-style
 * frameworks: `app.use('/cnos/vars', varServer(store, { base: '/cnos/vars' }))`.
 */
export function varServer(store: VarStore, options: VarServerOptions = {}): VarServerHandler {
  const base = options.base ?? '/cnos/vars';
  const authorize = options.authorize ?? allowAllWithWarning;
  const engine =
    options.engine ??
    createVarEngine(store, {
      ...(options.documents ? { documents: options.documents } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    });

  const adminBase = `${base}/admin`;

  return (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const { status, body } = errorStatus(error);
      sendJson(res, status, body);
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = parse(req, base);

    if (!parsed) {
      sendJson(res, 404, { error: `No var route for ${req.url}`, code: 'not-found' });
      return;
    }

    const { method, pathname, query } = parsed;
    const isMutation = pathname.startsWith(adminBase) && method === 'POST';
    const token = bearer(req);
    const scopeHint = query.get('key') ?? query.get('group') ?? query.get('scope') ?? undefined;

    const permitted = await authorize({
      kind: isMutation ? 'mutate' : 'read',
      ...(scopeHint !== undefined ? { scope: scopeHint } : {}),
      ...(token !== undefined ? { token } : {}),
    });

    if (!permitted) {
      sendJson(res, 403, { error: 'Not authorized for this var scope.', code: 'forbidden' });
      return;
    }

    // Read plane.
    if (pathname === base && method === 'GET') {
      handleRead(req, res, query);
      return;
    }

    if (pathname === `${adminBase}/revisions` && method === 'POST') {
      const body = asRecord(await readBody(req));
      const result = await engine.createRevision({
        scope: requireString(body, 'scope'),
        document: body.document,
        ...(typeof body.schemaId === 'string' ? { schemaId: body.schemaId } : {}),
        ...(typeof body.schemaVersion === 'string' ? { schemaVersion: body.schemaVersion } : {}),
        ...metadata(body),
      });
      sendJson(res, result.created ? 201 : 200, result);
      return;
    }

    if (pathname === `${adminBase}/validate` && method === 'POST') {
      const body = asRecord(await readBody(req));
      const result = engine.validateRevision(
        body.document,
        typeof body.schemaId === 'string' ? body.schemaId : undefined,
        typeof body.scope === 'string' ? body.scope : undefined,
      );
      sendJson(res, 200, result);
      return;
    }

    if (pathname === `${adminBase}/activate` && method === 'POST') {
      const body = asRecord(await readBody(req));
      const result = await engine.activate({
        scope: requireString(body, 'scope'),
        revision: requireString(body, 'revision'),
        expectedGeneration: requireNumber(body, 'expectedGeneration'),
        ...metadata(body),
      });
      sendJson(res, 200, result);
      return;
    }

    if (pathname === `${adminBase}/deactivate` && method === 'POST') {
      const body = asRecord(await readBody(req));
      const result = await engine.deactivate({
        scope: requireString(body, 'scope'),
        expectedGeneration: requireNumber(body, 'expectedGeneration'),
        ...metadata(body),
      });
      sendJson(res, 200, result);
      return;
    }

    if (pathname === `${adminBase}/rollback` && method === 'POST') {
      const body = asRecord(await readBody(req));
      const result = await engine.rollback({
        scope: requireString(body, 'scope'),
        expectedGeneration: requireNumber(body, 'expectedGeneration'),
        ...(typeof body.toRevision === 'string' ? { toRevision: body.toRevision } : {}),
        ...(typeof body.toGeneration === 'number' ? { toGeneration: body.toGeneration } : {}),
        ...metadata(body),
      });
      sendJson(res, 200, result);
      return;
    }

    if (pathname === `${adminBase}/status` && method === 'GET') {
      const scope = query.get('scope') ?? query.get('key') ?? query.get('group');

      if (!scope) {
        sendJson(res, 400, { error: 'status requires a scope query parameter.', code: 'bad-request' });
        return;
      }

      sendJson(res, 200, engine.status(scope));
      return;
    }

    if (pathname === `${adminBase}/history` && method === 'GET') {
      const scope = query.get('scope') ?? query.get('key') ?? query.get('group');

      if (!scope) {
        sendJson(res, 400, { error: 'history requires a scope query parameter.', code: 'bad-request' });
        return;
      }

      sendJson(res, 200, { scope, events: engine.history(scope) });
      return;
    }

    if (pathname === `${adminBase}/replay` && method === 'GET') {
      const scope = query.get('scope') ?? query.get('key') ?? query.get('group');
      const toGeneration = Number(query.get('toGeneration'));

      if (!scope || !Number.isFinite(toGeneration)) {
        sendJson(res, 400, { error: 'replay requires scope and toGeneration query parameters.', code: 'bad-request' });
        return;
      }

      const head = engine.replay(scope, toGeneration);
      sendJson(res, head ? 200 : 404, head ?? { error: `No state at generation ${toGeneration}.`, code: 'not-found' });
      return;
    }

    sendJson(res, 404, { error: `No var route for ${method} ${pathname}`, code: 'not-found' });
  }

  function handleRead(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
    const scope = query.get('key') ?? query.get('group');

    if (!scope) {
      sendJson(res, 400, { error: 'Read requires a key or group query parameter.', code: 'bad-request' });
      return;
    }

    const head = store.head(scope);

    if (!head) {
      sendJson(res, 404, { error: `No active runtime head for var scope "${scope}".`, code: 'no-head' });
      return;
    }

    const ifNoneMatch = req.headers['if-none-match'];

    if (ifNoneMatch && ifNoneMatch === head.revision) {
      res.writeHead(304, { etag: head.revision });
      res.end();
      return;
    }

    sendJson(
      res,
      200,
      {
        generation: head.generation,
        revision: head.revision,
        ...(head.schemaId !== undefined ? { schemaId: head.schemaId } : {}),
        ...(head.schemaVersion !== undefined ? { schemaVersion: head.schemaVersion } : {}),
        effectiveAt: head.effectiveAt,
        values: head.values,
      },
      { etag: head.revision },
    );
  }
}

function metadata(body: Record<string, unknown>): {
  actor?: string;
  reason?: string;
  idempotencyKey?: string;
} {
  return {
    ...(typeof body.actor === 'string' ? { actor: body.actor } : {}),
    ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
    ...(typeof body.idempotencyKey === 'string' ? { idempotencyKey: body.idempotencyKey } : {}),
  };
}
