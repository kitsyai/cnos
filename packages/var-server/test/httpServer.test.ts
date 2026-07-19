import type { DocumentSchemaDefinition } from '@kitsy/cnos-core';
import { afterEach, describe, expect, it } from 'vitest';

import { memoryStore, serveVarServer, staticBearerAuthorize, type RunningVarServer } from '../src/index.js';

const SCHEMA: DocumentSchemaDefinition = {
  fields: {
    enabled: { type: 'boolean', required: true },
    model_target_ref: { type: 'string', required: true },
  },
  additionalProperties: false,
};

const documents = { 'agentic-lanes/v1': SCHEMA };
const SCOPE = 'agentic.lanes.vinci';
const DOC = { enabled: true, model_target_ref: 'secret.ops.model' };

let running: RunningVarServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function post(base: string, route: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe('varServer http protocol', () => {
  it('serves the read plane with ETag and 304 semantics, and 404 with no head', async () => {
    running = await serveVarServer(memoryStore(), { documents });
    const base = running.url;

    // No head yet.
    const missing = await fetch(`${base}?key=${SCOPE}`);
    expect(missing.status).toBe(404);

    const created = await (await post(base, '/admin/revisions', { scope: SCOPE, document: DOC, schemaId: 'agentic-lanes/v1' })).json();
    await post(base, '/admin/activate', { scope: SCOPE, revision: created.revision, expectedGeneration: 0 });

    const read = await fetch(`${base}?key=${SCOPE}`);
    expect(read.status).toBe(200);
    expect(read.headers.get('etag')).toBe(created.revision);
    const payload = await read.json();
    expect(payload).toMatchObject({ generation: 1, revision: created.revision, values: DOC, schemaId: 'agentic-lanes/v1' });

    // If-None-Match matching the revision yields 304.
    const notModified = await fetch(`${base}?key=${SCOPE}`, { headers: { 'if-none-match': created.revision } });
    expect(notModified.status).toBe(304);
  });

  it('returns 422 for an invalid revision and 409 for a stale expected-generation', async () => {
    running = await serveVarServer(memoryStore(), { documents });
    const base = running.url;

    const invalid = await post(base, '/admin/revisions', {
      scope: SCOPE,
      document: { enabled: true, model_target_ref: 'x', extra: 1 },
      schemaId: 'agentic-lanes/v1',
    });
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).code).toBe('revision-invalid');

    const created = await (await post(base, '/admin/revisions', { scope: SCOPE, document: DOC, schemaId: 'agentic-lanes/v1' })).json();
    await post(base, '/admin/activate', { scope: SCOPE, revision: created.revision, expectedGeneration: 0 });

    const conflict = await post(base, '/admin/activate', { scope: SCOPE, revision: created.revision, expectedGeneration: 0 });
    expect(conflict.status).toBe(409);
    const body = await conflict.json();
    expect(body.code).toBe('revision-conflict');
    expect(body.currentGeneration).toBe(1);
  });

  it('enforces the bearer-token authorizer (403 without a valid token)', async () => {
    running = await serveVarServer(memoryStore(), { documents, authorize: staticBearerAuthorize('sekret') });
    const base = running.url;

    const denied = await fetch(`${base}?key=${SCOPE}`);
    expect(denied.status).toBe(403);

    const created = await post(base, '/admin/revisions', { scope: SCOPE, document: DOC, schemaId: 'agentic-lanes/v1' }, 'sekret');
    expect(created.status).toBe(201);
  });

  it('exposes status and history without secret material', async () => {
    running = await serveVarServer(memoryStore(), { documents });
    const base = running.url;
    const created = await (await post(base, '/admin/revisions', { scope: SCOPE, document: DOC, schemaId: 'agentic-lanes/v1' })).json();
    await post(base, '/admin/activate', { scope: SCOPE, revision: created.revision, expectedGeneration: 0, actor: 'ops' });

    const status = await (await fetch(`${base}/admin/status?scope=${SCOPE}`)).json();
    expect(status).toMatchObject({ scope: SCOPE, active: true, generation: 1, source: 'runtime' });

    const history = await (await fetch(`${base}/admin/history?scope=${SCOPE}`)).json();
    expect(history.events).toHaveLength(2);
    expect(history.events.map((event: { kind: string }) => event.kind)).toEqual(['revision-created', 'activated']);
  });
});
