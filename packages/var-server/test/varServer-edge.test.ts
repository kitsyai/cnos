import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DocumentSchemaDefinition } from '@kitsy/cnos-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CnosVarConflictError,
  createVarEngine,
  fileStore,
  memoryStore,
  serveVarServer,
  type RunningVarServer,
  type VarAuthContext,
} from '../src/index.js';

/**
 * W5b test hardening for the var-server control plane: acceptance-matrix gaps, adversarial
 * inputs, the authorize-hook contract (#12), concurrency, and secret-leak regressions.
 *
 * `PINNED:` marks behavior the design doc left unspecified that this suite encodes as the
 * current contract. `DEFECT-PIN:` marks behavior a reasonable reader would call wrong.
 */

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
const tempDirs: string[] = [];

afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cnos-var-srv-'));
  tempDirs.push(dir);
  return dir;
}

async function raw(
  base: string,
  route: string,
  init: RequestInit & { body?: string } = {},
): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${route}`, { method: 'POST', ...init });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON body is itself an assertion target */
  }
  return { status: response.status, text, json };
}

async function post(base: string, route: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const result = await raw(base, route, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: result.status, json: result.json };
}

/** Seed one activated head and return the server + its current generation. */
async function seeded(): Promise<{ base: string; generation: number }> {
  running = await serveVarServer(memoryStore(), { documents });
  const created = await post(running.url, '/admin/revisions', {
    scope: SCOPE,
    document: DOC,
    schemaId: 'agentic-lanes/v1',
  });
  await post(running.url, '/admin/activate', {
    scope: SCOPE,
    revision: created.json.revision,
    expectedGeneration: 0,
  });
  return { base: running.url, generation: 1 };
}

// ---------------------------------------------------------------------------
// A. Acceptance matrix — control-plane items with no direct HTTP-layer test
// ---------------------------------------------------------------------------

describe('acceptance matrix (control plane)', () => {
  it('acceptance #2: an activation is immediately visible on the read plane (no restart)', async () => {
    const { base } = await seeded();
    const read = await fetch(`${base}?key=${encodeURIComponent(SCOPE)}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ generation: 1, values: { [SCOPE]: DOC } });

    const next = await post(base, '/admin/revisions', {
      scope: SCOPE,
      document: { enabled: false, model_target_ref: 'secret.ops.model' },
      schemaId: 'agentic-lanes/v1',
    });
    await post(base, '/admin/activate', { scope: SCOPE, revision: next.json.revision, expectedGeneration: 1 });

    const after = (await (await fetch(`${base}?key=${encodeURIComponent(SCOPE)}`)).json()) as {
      generation: number;
      values: Record<string, unknown>;
    };
    expect(after.generation).toBe(2);
    expect(after.values[SCOPE]).toEqual({ enabled: false, model_target_ref: 'secret.ops.model' });
  });

  it('acceptance #6: generations are strictly monotonic across activate/deactivate/rollback', async () => {
    const { base } = await seeded();
    const first = await post(base, '/admin/status?scope=' + encodeURIComponent(SCOPE), {});
    void first;

    const alt = await post(base, '/admin/revisions', {
      scope: SCOPE,
      document: { enabled: false, model_target_ref: 'ref' },
      schemaId: 'agentic-lanes/v1',
    });
    const seen: number[] = [1];
    seen.push(((await post(base, '/admin/activate', { scope: SCOPE, revision: alt.json.revision, expectedGeneration: 1 })).json.generation as number));
    seen.push(((await post(base, '/admin/deactivate', { scope: SCOPE, expectedGeneration: 2 })).json.generation as number));
    seen.push(((await post(base, '/admin/rollback', { scope: SCOPE, toGeneration: 1, expectedGeneration: 3 })).json.generation as number));

    expect(seen).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1] as number);
    }
  });

  it('acceptance #7: a stale expected-generation conflicts with 409 and the precise generations', async () => {
    const { base } = await seeded();
    const alt = await post(base, '/admin/revisions', {
      scope: SCOPE,
      document: { enabled: false, model_target_ref: 'ref' },
      schemaId: 'agentic-lanes/v1',
    });
    const conflict = await post(base, '/admin/activate', {
      scope: SCOPE,
      revision: alt.json.revision,
      expectedGeneration: 0, // stale: the head is at 1
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toMatchObject({ expectedGeneration: 0, currentGeneration: 1 });
    // The head is untouched by the failed write.
    const status = await (await fetch(`${base}/admin/status?scope=${encodeURIComponent(SCOPE)}`)).json();
    expect(status).toMatchObject({ generation: 1, active: true });
  });

  it('acceptance #8: rollback is audited as a NEW activation event referencing the prior revision', async () => {
    const { base } = await seeded();
    const original = (await (await fetch(`${base}/admin/status?scope=${encodeURIComponent(SCOPE)}`)).json()) as {
      revision: string;
    };
    const alt = await post(base, '/admin/revisions', {
      scope: SCOPE,
      document: { enabled: false, model_target_ref: 'ref' },
      schemaId: 'agentic-lanes/v1',
    });
    await post(base, '/admin/activate', { scope: SCOPE, revision: alt.json.revision, expectedGeneration: 1 });
    const rolled = await post(base, '/admin/rollback', {
      scope: SCOPE,
      toRevision: original.revision,
      expectedGeneration: 2,
      actor: 'oncall@example.com',
    });

    expect(rolled.status).toBe(200);
    expect(rolled.json).toMatchObject({ generation: 3, revision: original.revision });

    const history = (await (await fetch(`${base}/admin/history?scope=${encodeURIComponent(SCOPE)}`)).json()) as {
      events: Array<Record<string, unknown>>;
    };
    const last = history.events[history.events.length - 1];
    expect(last).toMatchObject({
      kind: 'activated',
      generation: 3,
      revision: original.revision,
      previousGeneration: 2,
      actor: 'oncall@example.com',
    });
    expect(String(last?.reason)).toContain('rollback');
  });

  it('acceptance #9: a fileStore-backed server resumes the active head after a restart', async () => {
    const dir = await tempDir();
    const logPath = path.join(dir, 'vars.jsonl');

    running = await serveVarServer(await fileStore(logPath), { documents });
    const created = await post(running.url, '/admin/revisions', { scope: SCOPE, document: DOC, schemaId: 'agentic-lanes/v1' });
    await post(running.url, '/admin/activate', { scope: SCOPE, revision: created.json.revision, expectedGeneration: 0 });
    await running.close();

    running = await serveVarServer(await fileStore(logPath), { documents });
    const head = await (await fetch(`${running.url}?key=${encodeURIComponent(SCOPE)}`)).json();
    expect(head).toMatchObject({ generation: 1, values: { [SCOPE]: DOC } });
    // The recovered generation is the guard the next writer must present.
    const conflict = await post(running.url, '/admin/deactivate', { scope: SCOPE, expectedGeneration: 0 });
    expect(conflict.status).toBe(409);
  });

  it('acceptance #15: deactivate removes the head so consumers fall back (404 no-head)', async () => {
    const { base } = await seeded();
    const off = await post(base, '/admin/deactivate', { scope: SCOPE, expectedGeneration: 1 });
    expect(off.status).toBe(200);

    const read = await fetch(`${base}?key=${encodeURIComponent(SCOPE)}`);
    expect(read.status).toBe(404);
    expect(await read.json()).toMatchObject({ code: 'no-head' });

    // ...and re-activating the same revision flips it back with no deployment.
    const status = (await (await fetch(`${base}/admin/history?scope=${encodeURIComponent(SCOPE)}`)).json()) as {
      events: Array<{ kind: string; revision?: string }>;
    };
    const revision = status.events.find((event) => event.kind === 'revision-created')?.revision;
    const back = await post(base, '/admin/activate', { scope: SCOPE, revision, expectedGeneration: 2 });
    expect(back.status).toBe(200);
    expect((await fetch(`${base}?key=${encodeURIComponent(SCOPE)}`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// A/#12. Authorize hook contract — pinned even though scoped authz is future work
// ---------------------------------------------------------------------------

describe('acceptance #12: authorize hook contract (scoped authz is NOT yet implemented)', () => {
  it('denies a READ with 403 and the forbidden code, and never reveals the head', async () => {
    const calls: VarAuthContext[] = [];
    running = await serveVarServer(memoryStore(), {
      documents,
      authorize: (ctx) => {
        calls.push(ctx);
        return false;
      },
    });

    const read = await fetch(`${running.url}?key=${encodeURIComponent(SCOPE)}`);
    expect(read.status).toBe(403);
    expect(await read.json()).toEqual({ error: 'Not authorized for this var scope.', code: 'forbidden' });
    expect(calls[0]).toMatchObject({ kind: 'read', scope: SCOPE });
  });

  it('denies a MUTATION with 403 and appends NOTHING to the log', async () => {
    const store = memoryStore();
    running = await serveVarServer(store, { documents, authorize: (ctx) => ctx.kind !== 'mutate' });

    const denied = await post(running.url, '/admin/revisions', { scope: SCOPE, document: DOC, schemaId: 'agentic-lanes/v1' });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('forbidden');
    expect(store.history(SCOPE)).toEqual([]);
    expect(store.currentGeneration(SCOPE)).toBe(0);
  });

  it('passes kind, scope hint (key/group/scope query params) and bearer token to the hook', async () => {
    const calls: VarAuthContext[] = [];
    running = await serveVarServer(memoryStore(), {
      documents,
      authorize: (ctx) => {
        calls.push(ctx);
        return true;
      },
    });

    await fetch(`${running.url}?key=a.b`, { headers: { authorization: 'Bearer tok-1' } });
    await fetch(`${running.url}?group=a`, { headers: { authorization: 'bearer tok-2' } });
    await fetch(`${running.url}/admin/status?scope=a.b`);
    await post(running.url, '/admin/revisions', { scope: SCOPE, document: DOC, schemaId: 'agentic-lanes/v1' });

    expect(calls[0]).toEqual({ kind: 'read', scope: 'a.b', token: 'tok-1' });
    expect(calls[1]).toEqual({ kind: 'read', scope: 'a', token: 'tok-2' }); // case-insensitive scheme
    expect(calls[2]).toEqual({ kind: 'read', scope: 'a.b' }); // no token → key omitted entirely
    // GAP: mutations carry their scope in the JSON BODY, so the hook sees no scope for them.
    // Scoped (business/environment/component) authz therefore cannot be enforced on writes
    // with the v1 hook — see the W5b report.
    expect(calls[3]).toEqual({ kind: 'mutate' });
  });

  it('DEFECT-PIN: only POST under /admin is classified as a mutation; admin GETs are `read`', async () => {
    const calls: VarAuthContext[] = [];
    running = await serveVarServer(memoryStore(), {
      documents,
      authorize: (ctx) => {
        calls.push(ctx);
        return true;
      },
    });

    // /admin/status, /admin/history and /admin/replay expose the full audit log but are
    // authorized as `read`. An authorizer that only guards `mutate` leaks the audit trail.
    await fetch(`${running.url}/admin/history?scope=${encodeURIComponent(SCOPE)}`);
    await fetch(`${running.url}/admin/replay?scope=${encodeURIComponent(SCOPE)}&toGeneration=1`);
    expect(calls.map((call) => call.kind)).toEqual(['read', 'read']);
  });

  it('a bearer authorizer that resolves to an empty token denies rather than allows', async () => {
    running = await serveVarServer(memoryStore(), {
      documents,
      authorize: (ctx) => ctx.token !== undefined && ctx.token.length > 0,
    });
    // Header present but empty after the scheme → no match, so no token is extracted.
    const res = await fetch(`${running.url}?key=${encodeURIComponent(SCOPE)}`, {
      headers: { authorization: 'Bearer ' },
    });
    expect(res.status).toBe(403);
  });

  it('a throwing authorize hook fails closed with 500, not open', async () => {
    running = await serveVarServer(memoryStore(), {
      documents,
      authorize: () => {
        throw new Error('identity provider unreachable');
      },
    });
    const res = await fetch(`${running.url}?key=${encodeURIComponent(SCOPE)}`);
    expect(res.status).toBe(500);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ code: 'internal' });
  });
});

// ---------------------------------------------------------------------------
// B. Adversarial input
// ---------------------------------------------------------------------------

describe('adversarial request handling', () => {
  it('rejects truncated / invalid JSON with 400 bad-request instead of crashing', async () => {
    running = await serveVarServer(memoryStore(), { documents });
    for (const body of ['{', '{"scope":', '[1,2', 'not json at all', '{"a":1}}']) {
      const res = await raw(running.url, '/admin/revisions', {
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(400);
      expect(res.json.code).toBe('bad-request');
    }
  });

  it('PINNED: the content-type header is ignored; the body is always parsed as JSON', async () => {
    running = await serveVarServer(memoryStore(), { documents });
    const ok = await raw(running.url, '/admin/validate', {
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ document: DOC, schemaId: 'agentic-lanes/v1', scope: SCOPE }),
    });
    expect(ok.status).toBe(200);
    expect(ok.json.valid).toBe(true);

    const bad = await raw(running.url, '/admin/validate', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'scope=a&document=b',
    });
    expect(bad.status).toBe(400);
  });

  it('treats an empty body as an empty object and reports the missing required field', async () => {
    running = await serveVarServer(memoryStore(), { documents });
    for (const body of ['', '   ', '\n']) {
      const res = await raw(running.url, '/admin/activate', { body });
      expect(res.status).toBe(400);
      expect(String(res.json.error)).toContain('scope');
    }
  });

  it('rejects a non-object top-level body (array / scalar / null) via the missing-field guard', async () => {
    running = await serveVarServer(memoryStore(), { documents });
    for (const body of ['[]', '"str"', '42', 'null', 'true']) {
      const res = await raw(running.url, '/admin/activate', {
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(400);
      // PINNED: missing/!invalid-field errors surface as CnosVarStoreError, whose wire code is
      // `store-unsupported` — a misleading label for a malformed request. Pinned, not fixed.
      expect(res.json.code).toBe('store-unsupported');
    }
  });

  it('rejects a non-numeric / non-finite expectedGeneration', async () => {
    const { base } = await seeded();
    for (const expectedGeneration of ['1', null, [], {}, Number.NaN]) {
      const res = await post(base, '/admin/deactivate', { scope: SCOPE, expectedGeneration });
      expect(res.status).toBe(400);
      expect(String(res.json.error)).toContain('expectedGeneration');
    }
  });

  it('rejects group-scoped documents that are not keyed by full var keys (var.group-scope-shape)', async () => {
    running = await serveVarServer(memoryStore(), { documents });
    for (const document of [null, [1, 2], 'scalar', 42, { wrong: 1 }, { 'other.k': 1 }]) {
      const res = await post(running.url, '/admin/revisions', { scope: 'agentic', document });
      expect(res.status).toBe(422);
      expect((res.json.issues as Array<{ code: string }>).some((issue) => issue.code === 'var.group-scope-shape')).toBe(true);
    }
    // The correctly-keyed shape passes.
    const ok = await post(running.url, '/admin/revisions', { scope: 'agentic', document: { 'agentic.k': 1 } });
    expect(ok.status).toBe(201);
  });

  it('rejects a revision naming an unregistered document schema (422 document.unknown-schema)', async () => {
    running = await serveVarServer(memoryStore(), { documents });
    const res = await post(running.url, '/admin/revisions', { scope: SCOPE, document: DOC, schemaId: 'nope/v9' });
    expect(res.status).toBe(422);
    expect((res.json.issues as Array<{ code: string }>)[0]?.code).toBe('document.unknown-schema');
  });

  it('404s unknown routes and unknown methods without leaking internals', async () => {
    running = await serveVarServer(memoryStore(), { documents });
    const outside = await fetch(`${running.url.replace('/cnos/vars', '')}/nope`);
    expect(outside.status).toBe(404);
    const wrongMethod = await fetch(`${running.url}/admin/activate`, { method: 'GET' });
    expect(wrongMethod.status).toBe(404);
    const del = await fetch(`${running.url}/admin/revisions`, { method: 'DELETE' });
    expect(del.status).toBe(404);
  });

  it('requires a scope query parameter on read / status / history / replay', async () => {
    running = await serveVarServer(memoryStore(), { documents });
    for (const route of ['', '/admin/status', '/admin/history']) {
      const res = await fetch(`${running.url}${route}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as Record<string, unknown>).code).toBe('bad-request');
    }
    expect((await fetch(`${running.url}/admin/replay?scope=a`)).status).toBe(400);
    expect((await fetch(`${running.url}/admin/replay?toGeneration=1`)).status).toBe(400);
  });

  it('round-trips unicode and dotted-looking scope names through the whole mutation path', async () => {
    running = await serveVarServer(memoryStore(), { documents });
    const scope = 'グループ.日本.ключ';
    const created = await post(running.url, '/admin/revisions', { scope, document: { ok: true } });
    expect(created.status).toBe(201);
    await post(running.url, '/admin/activate', { scope, revision: created.json.revision, expectedGeneration: 0 });
    const head = await (await fetch(`${running.url}?key=${encodeURIComponent(scope)}`)).json();
    expect(head).toMatchObject({ generation: 1, values: { [scope]: { ok: true } } });
  });

  it('SLOW-ISH: accepts a multi-megabyte revision document and serves it back intact', async () => {
    running = await serveVarServer(memoryStore(), { documents });
    const blob = 'y'.repeat(2 * 1024 * 1024); // 2 MiB
    const created = await post(running.url, '/admin/revisions', { scope: 'big.doc', document: { blob } });
    expect(created.status).toBe(201);
    await post(running.url, '/admin/activate', { scope: 'big.doc', revision: created.json.revision, expectedGeneration: 0 });
    const head = (await (await fetch(`${running.url}?key=big.doc`)).json()) as {
      values: Record<string, { blob: string }>;
    };
    expect(head.values['big.doc']?.blob.length).toBe(blob.length);
  }, 20_000);

  it('accepts a deeply nested document without stack overflow', async () => {
    running = await serveVarServer(memoryStore(), { documents });
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 400; i += 1) {
      nested = { child: nested };
    }
    const created = await post(running.url, '/admin/revisions', { scope: 'deep.doc', document: nested });
    expect(created.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// B. Concurrency
// ---------------------------------------------------------------------------

describe('concurrency on the mutation path', () => {
  it('acceptance #7: concurrent activates on one scope — EXACTLY one wins, the rest 409', async () => {
    const store = memoryStore();
    const engine = createVarEngine(store, { documents });
    const created = await engine.createRevision({ scope: SCOPE, document: DOC, schemaId: 'agentic-lanes/v1' });
    const alt = await engine.createRevision({
      scope: SCOPE,
      document: { enabled: false, model_target_ref: 'ref' },
      schemaId: 'agentic-lanes/v1',
    });

    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        engine.activate({
          scope: SCOPE,
          revision: index % 2 === 0 ? created.revision : alt.revision,
          expectedGeneration: 0,
        }),
      ),
    );

    const won = attempts.filter((result) => result.status === 'fulfilled');
    const lost = attempts.filter((result) => result.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(11);
    for (const failure of lost) {
      expect((failure as PromiseRejectedResult).reason).toBeInstanceOf(CnosVarConflictError);
    }
    expect(engine.status(SCOPE).generation).toBe(1);
    // No lost update: the log carries exactly one activation.
    expect(engine.history(SCOPE).filter((event) => event.kind === 'activated')).toHaveLength(1);
  });

  it('acceptance #6: a serialized chain of activates allocates every generation exactly once', async () => {
    const store = memoryStore();
    const engine = createVarEngine(store, { documents });
    const created = await engine.createRevision({ scope: SCOPE, document: DOC, schemaId: 'agentic-lanes/v1' });

    const generations: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const result = await engine.activate({ scope: SCOPE, revision: created.revision, expectedGeneration: i });
      generations.push(result.generation);
    }
    expect(generations).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    expect(new Set(generations).size).toBe(25);
  });

  it('acceptance #3: interleaved reads during a commit storm never observe a mixed head', async () => {
    const store = memoryStore();
    const engine = createVarEngine(store, { documents });
    const groupScope = 'agentic';
    const revisions: string[] = [];

    for (let i = 0; i < 10; i += 1) {
      const created = await engine.createRevision({
        scope: groupScope,
        document: { 'agentic.a': i, 'agentic.b': i, 'agentic.c': i },
      });
      revisions.push(created.revision);
    }

    const observed: Array<Record<string, unknown>> = [];
    const reader = setInterval(() => {
      const head = store.head(groupScope);
      if (head) {
        observed.push(head.values);
      }
    }, 0);

    for (let i = 0; i < 10; i += 1) {
      await engine.activate({ scope: groupScope, revision: revisions[i] as string, expectedGeneration: i });
      observed.push(store.head(groupScope)?.values ?? {});
    }
    clearInterval(reader);

    expect(observed.length).toBeGreaterThan(0);
    for (const values of observed) {
      // Every observed head is internally consistent: all three keys share one revision's value.
      expect(values.a === values.b || values['agentic.a'] === values['agentic.b']).toBe(true);
      expect(values['agentic.a']).toBe(values['agentic.c']);
    }
  });

  it('concurrent identical idempotency keys collapse to a single activation event', async () => {
    const store = memoryStore();
    const engine = createVarEngine(store, { documents });
    const created = await engine.createRevision({ scope: SCOPE, document: DOC, schemaId: 'agentic-lanes/v1' });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        engine.activate({ scope: SCOPE, revision: created.revision, expectedGeneration: 0, idempotencyKey: 'same-key' }),
      ),
    );
    const fulfilled = results.filter((entry) => entry.status === 'fulfilled') as Array<PromiseFulfilledResult<{ generation: number }>>;

    // Every fulfilled call reports the SAME generation and only one event is appended.
    expect(new Set(fulfilled.map((entry) => entry.value.generation)).size).toBe(1);
    expect(engine.history(SCOPE).filter((event) => event.kind === 'activated')).toHaveLength(1);
    expect(engine.status(SCOPE).generation).toBe(1);
  });

  it('mutations on DIFFERENT scopes are not serialized against each other', async () => {
    const store = memoryStore();
    const engine = createVarEngine(store, { documents });
    const scopes = ['s.one', 's.two', 's.three', 's.four'];
    const created = await Promise.all(scopes.map((scope) => engine.createRevision({ scope, document: { v: scope } })));

    const results = await Promise.all(
      scopes.map((scope, index) =>
        engine.activate({ scope, revision: (created[index] as { revision: string }).revision, expectedGeneration: 0 }),
      ),
    );
    expect(results.map((result) => result.generation)).toEqual([1, 1, 1, 1]);
  });
});

// ---------------------------------------------------------------------------
// C. Security regressions (Critical Rules 4/5)
// ---------------------------------------------------------------------------

describe('acceptance #13: no secret material anywhere on the control plane', () => {
  const SECRET_LITERAL = 'SUPER-SECRET-MATERIAL-9f3a';

  it('a document may carry a secret.* REF; the ref is never resolved and no material appears', async () => {
    const dir = await tempDir();
    const logPath = path.join(dir, 'vars.jsonl');
    running = await serveVarServer(await fileStore(logPath), { documents });

    const document = { enabled: true, model_target_ref: 'secret.ops.model' };
    const created = await post(running.url, '/admin/revisions', { scope: SCOPE, document, schemaId: 'agentic-lanes/v1' });
    await post(running.url, '/admin/activate', {
      scope: SCOPE,
      revision: created.json.revision,
      expectedGeneration: 0,
      actor: 'ops',
      reason: 'enable vinci',
    });

    const head = await (await fetch(`${running.url}?key=${encodeURIComponent(SCOPE)}`)).text();
    const status = await (await fetch(`${running.url}/admin/status?scope=${encodeURIComponent(SCOPE)}`)).text();
    const history = await (await fetch(`${running.url}/admin/history?scope=${encodeURIComponent(SCOPE)}`)).text();
    const log = await readFile(logPath, 'utf8');

    for (const surface of [head, status, history, log]) {
      expect(surface).not.toContain(SECRET_LITERAL);
      // The opaque ref survives verbatim — it is NOT dereferenced anywhere.
      expect(surface.includes('secret.ops.model') || surface.includes('sha256:')).toBe(true);
    }
    expect(head).toContain('secret.ops.model');
    expect(log).toContain('secret.ops.model');
  });

  it('a rejected revision records only the reason — never the offending document body', async () => {
    const dir = await tempDir();
    const logPath = path.join(dir, 'vars.jsonl');
    running = await serveVarServer(await fileStore(logPath), { documents });

    const rejected = await post(running.url, '/admin/revisions', {
      scope: SCOPE,
      // `leaked` is an unknown field AND carries the secret literal.
      document: { enabled: true, model_target_ref: 'ref', leaked: SECRET_LITERAL },
      schemaId: 'agentic-lanes/v1',
    });
    expect(rejected.status).toBe(422);

    const log = await readFile(logPath, 'utf8');
    const history = await (await fetch(`${running.url}/admin/history?scope=${encodeURIComponent(SCOPE)}`)).text();

    expect(log).toContain('"kind":"rejected"');
    expect(log).not.toContain(SECRET_LITERAL);
    expect(history).not.toContain(SECRET_LITERAL);
    // The response itself names the offending FIELD but not its value.
    expect(JSON.stringify(rejected.json)).toContain('leaked');
    expect(JSON.stringify(rejected.json)).not.toContain(SECRET_LITERAL);
  });

  it('the status surface exposes metadata only (no `values` document body)', async () => {
    const { base } = await seeded();
    const status = (await (await fetch(`${base}/admin/status?scope=${encodeURIComponent(SCOPE)}`)).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(status).sort()).not.toContain('values');
    expect(status).toMatchObject({ scope: SCOPE, active: true, generation: 1, source: 'runtime' });
  });

  it('an internal error response carries a message but no request body echo', async () => {
    running = await serveVarServer(memoryStore(), {
      documents,
      authorize: () => {
        throw new Error('boom');
      },
    });
    const res = await raw(running.url, '/admin/revisions', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: SCOPE, document: { token: SECRET_LITERAL } }),
    });
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(SECRET_LITERAL);
  });
});
