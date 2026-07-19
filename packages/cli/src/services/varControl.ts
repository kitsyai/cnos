import { readFile } from 'node:fs/promises';

import type { DocumentSchemaDefinition } from '@kitsy/cnos-core';
import {
  createVarEngine,
  fileStore,
  serveVarServer,
  staticBearerAuthorize,
  type RunningVarServer,
  type VarEngine,
} from '@kitsy/cnos-var-server';

export interface VarMutationMeta {
  actor?: string;
  reason?: string;
  idempotencyKey?: string;
}

/** Parse a `--document` argument: `@path` reads a JSON file, otherwise inline JSON. */
export async function parseDocumentArg(raw: string): Promise<unknown> {
  const text = raw.startsWith('@') ? await readFile(raw.slice(1), 'utf8') : raw;

  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse --document as JSON (${message}). Pass inline JSON or @path/to/file.json.`);
  }
}

async function remoteRequest(
  server: string,
  method: 'GET' | 'POST',
  routePath: string,
  body?: unknown,
  bearer?: string,
): Promise<unknown> {
  const base = server.replace(/\/$/, '');
  const headers: Record<string, string> = {};

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  if (bearer) {
    headers.authorization = `Bearer ${bearer}`;
  }

  const response = await fetch(`${base}${routePath}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    const message = typeof parsed.error === 'string' ? parsed.error : `var server returned ${response.status}`;
    throw new Error(message);
  }

  return parsed;
}

/** Uniform local/remote control surface for `cnos var` mutation and inspection commands. */
export interface VarControl {
  createRevision(scope: string, document: unknown, schemaId: string | undefined, meta: VarMutationMeta): Promise<unknown>;
  validateRevision(scope: string | undefined, document: unknown, schemaId: string | undefined): Promise<unknown>;
  activate(scope: string, revision: string, expectedGeneration: number, meta: VarMutationMeta): Promise<unknown>;
  deactivate(scope: string, expectedGeneration: number, meta: VarMutationMeta): Promise<unknown>;
  rollback(
    scope: string,
    expectedGeneration: number,
    target: { toRevision?: string; toGeneration?: number },
    meta: VarMutationMeta,
  ): Promise<unknown>;
  status(scope: string): Promise<unknown>;
  history(scope: string): Promise<unknown>;
  replay(scope: string, toGeneration: number): Promise<unknown>;
}

export interface LocalVarControlOptions {
  storePath: string;
  documents?: Record<string, DocumentSchemaDefinition>;
}

export function createLocalVarControl(options: LocalVarControlOptions): VarControl {
  const engine: VarEngine = createVarEngine(fileStore(options.storePath), {
    ...(options.documents ? { documents: options.documents } : {}),
  });

  return {
    createRevision: (scope, document, schemaId, meta) =>
      engine.createRevision({ scope, document, ...(schemaId ? { schemaId } : {}), ...meta }),
    validateRevision: async (scope, document, schemaId) => engine.validateRevision(document, schemaId, scope),
    activate: (scope, revision, expectedGeneration, meta) =>
      engine.activate({ scope, revision, expectedGeneration, ...meta }),
    deactivate: (scope, expectedGeneration, meta) => engine.deactivate({ scope, expectedGeneration, ...meta }),
    rollback: (scope, expectedGeneration, target, meta) =>
      engine.rollback({ scope, expectedGeneration, ...target, ...meta }),
    status: async (scope) => engine.status(scope),
    history: async (scope) => ({ scope, events: engine.history(scope) }),
    replay: async (scope, toGeneration) => engine.replay(scope, toGeneration) ?? null,
  };
}

export interface RemoteVarControlOptions {
  server: string;
  bearer?: string;
}

export function createRemoteVarControl(options: RemoteVarControlOptions): VarControl {
  const { server, bearer } = options;

  return {
    createRevision: (scope, document, schemaId, meta) =>
      remoteRequest(server, 'POST', '/admin/revisions', { scope, document, schemaId, ...meta }, bearer),
    validateRevision: (scope, document, schemaId) =>
      remoteRequest(server, 'POST', '/admin/validate', { scope, document, schemaId }, bearer),
    activate: (scope, revision, expectedGeneration, meta) =>
      remoteRequest(server, 'POST', '/admin/activate', { scope, revision, expectedGeneration, ...meta }, bearer),
    deactivate: (scope, expectedGeneration, meta) =>
      remoteRequest(server, 'POST', '/admin/deactivate', { scope, expectedGeneration, ...meta }, bearer),
    rollback: (scope, expectedGeneration, target, meta) =>
      remoteRequest(server, 'POST', '/admin/rollback', { scope, expectedGeneration, ...target, ...meta }, bearer),
    status: (scope) => remoteRequest(server, 'GET', `/admin/status?scope=${encodeURIComponent(scope)}`, undefined, bearer),
    history: (scope) => remoteRequest(server, 'GET', `/admin/history?scope=${encodeURIComponent(scope)}`, undefined, bearer),
    replay: (scope, toGeneration) =>
      remoteRequest(
        server,
        'GET',
        `/admin/replay?scope=${encodeURIComponent(scope)}&toGeneration=${toGeneration}`,
        undefined,
        bearer,
      ),
  };
}

export interface ServeOptions {
  storePath?: string;
  documents?: Record<string, DocumentSchemaDefinition>;
  host?: string;
  port?: number;
  bearerToken?: string;
}

/** Start a standalone var server (`cnos var serve`). Resolves once it is listening. */
export async function startStandaloneVarServer(options: ServeOptions): Promise<RunningVarServer> {
  const store = options.storePath ? fileStore(options.storePath) : (await import('@kitsy/cnos-var-server')).memoryStore();

  return serveVarServer(store, {
    ...(options.documents ? { documents: options.documents } : {}),
    ...(options.bearerToken ? { authorize: staticBearerAuthorize(options.bearerToken) } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
  });
}
