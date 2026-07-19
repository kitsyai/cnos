import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DocumentSchemaDefinition } from '@kitsy/cnos-core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CnosVarConflictError,
  CnosVarValidationError,
  createVarEngine,
  fileStore,
  memoryStore,
  revisionHash,
} from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempLog(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-var-server-'));
  roots.push(root);
  return path.join(root, 'var-log.jsonl');
}

const SCHEMA: DocumentSchemaDefinition = {
  fields: {
    enabled: { type: 'boolean', required: true },
    model_target_ref: { type: 'string', required: true },
    max_input_tokens: { type: 'number' },
  },
  additionalProperties: false,
};

const documents = { 'agentic-lanes/v1': SCHEMA };

function counterClock(): () => string {
  let n = 0;
  return () => `2026-07-20T00:00:${String(n++).padStart(2, '0')}.000Z`;
}

const SCOPE = 'agentic.lanes.vinci';
const DOC_A = { enabled: true, model_target_ref: 'secret.ops.model_a' };
const DOC_B = { enabled: false, model_target_ref: 'secret.ops.model_b', max_input_tokens: 100 };

describe('var engine mutation model', () => {
  it('#6 allocates monotonic per-scope generations across activations and rollback', async () => {
    const engine = createVarEngine(memoryStore(), { documents, clock: counterClock() });
    const a = await engine.createRevision({ scope: SCOPE, document: DOC_A, schemaId: 'agentic-lanes/v1' });
    const b = await engine.createRevision({ scope: SCOPE, document: DOC_B, schemaId: 'agentic-lanes/v1' });

    const g1 = await engine.activate({ scope: SCOPE, revision: a.revision, expectedGeneration: 0 });
    expect(g1.generation).toBe(1);
    const g2 = await engine.activate({ scope: SCOPE, revision: b.revision, expectedGeneration: 1 });
    expect(g2.generation).toBe(2);
    const g3 = await engine.rollback({ scope: SCOPE, toRevision: a.revision, expectedGeneration: 2 });
    expect(g3.generation).toBe(3);
    expect(g3.revision).toBe(a.revision);
  });

  it('#7 rejects a stale expected-generation with a revision-conflict error', async () => {
    const engine = createVarEngine(memoryStore(), { documents, clock: counterClock() });
    const a = await engine.createRevision({ scope: SCOPE, document: DOC_A, schemaId: 'agentic-lanes/v1' });
    await engine.activate({ scope: SCOPE, revision: a.revision, expectedGeneration: 0 });

    await expect(engine.activate({ scope: SCOPE, revision: a.revision, expectedGeneration: 0 })).rejects.toBeInstanceOf(
      CnosVarConflictError,
    );
    // The stale write did not change the head.
    expect(engine.status(SCOPE).generation).toBe(1);
  });

  it('#8 rollback works and is audited as a new activation event', async () => {
    const engine = createVarEngine(memoryStore(), { documents, clock: counterClock() });
    const a = await engine.createRevision({ scope: SCOPE, document: DOC_A, schemaId: 'agentic-lanes/v1' });
    const b = await engine.createRevision({ scope: SCOPE, document: DOC_B, schemaId: 'agentic-lanes/v1' });
    await engine.activate({ scope: SCOPE, revision: a.revision, expectedGeneration: 0 });
    await engine.activate({ scope: SCOPE, revision: b.revision, expectedGeneration: 1 });
    await engine.rollback({ scope: SCOPE, toGeneration: 1, expectedGeneration: 2, actor: 'ops', reason: 'revert' });

    const head = engine.head(SCOPE);
    // Canonical: key-scoped `values` is keyed by the full var key.
    expect(head?.values).toEqual({ [SCOPE]: DOC_A });
    const activations = engine.history(SCOPE).filter((event) => event.kind === 'activated');
    expect(activations).toHaveLength(3);
    expect(activations.at(-1)?.reason).toBe('revert');
    expect(activations.at(-1)?.actor).toBe('ops');
  });

  it('#4/#5 rejects an invalid/unknown-field revision and leaves last-known-good active', async () => {
    const engine = createVarEngine(memoryStore(), { documents, clock: counterClock() });
    const a = await engine.createRevision({ scope: SCOPE, document: DOC_A, schemaId: 'agentic-lanes/v1' });
    await engine.activate({ scope: SCOPE, revision: a.revision, expectedGeneration: 0 });

    await expect(
      engine.createRevision({
        scope: SCOPE,
        document: { enabled: true, model_target_ref: 'x', budgets2: 1 },
        schemaId: 'agentic-lanes/v1',
      }),
    ).rejects.toBeInstanceOf(CnosVarValidationError);

    // Last-known-good untouched; a rejection event is recorded.
    const status = engine.status(SCOPE);
    expect(status.revision).toBe(a.revision);
    expect(status.generation).toBe(1);
    expect(status.lastRejected?.reason).toContain('unknown-field');
    expect(engine.head(SCOPE)?.values).toEqual({ [SCOPE]: DOC_A });
  });

  it('#3 never exposes a mixed snapshot under interleaved reads and activations', async () => {
    const store = memoryStore();
    const engine = createVarEngine(store, { documents, clock: counterClock() });
    const a = await engine.createRevision({ scope: SCOPE, document: DOC_A, schemaId: 'agentic-lanes/v1' });
    const b = await engine.createRevision({ scope: SCOPE, document: DOC_B, schemaId: 'agentic-lanes/v1' });
    await engine.activate({ scope: SCOPE, revision: a.revision, expectedGeneration: 0 });

    const observations: string[] = [];
    const readLoop = async (): Promise<void> => {
      for (let i = 0; i < 200; i += 1) {
        const head = store.head(SCOPE);
        if (head) {
          // Coherence invariant: the wrapped (key-scoped) value always hashes to the
          // advertised revision (the revision is the content hash of the as-authored doc).
          expect(revisionHash((head.values as Record<string, unknown>)[SCOPE])).toBe(head.revision);
          observations.push(head.revision);
        }
        await Promise.resolve();
      }
    };

    const flip = async (): Promise<void> => {
      let gen = 1;
      for (let i = 0; i < 20; i += 1) {
        const target = i % 2 === 0 ? b.revision : a.revision;
        const result = await engine.activate({ scope: SCOPE, revision: target, expectedGeneration: gen });
        gen = result.generation;
      }
    };

    await Promise.all([readLoop(), readLoop(), flip()]);
    // Both revisions were observed and every observation was coherent.
    expect(new Set(observations).size).toBeGreaterThan(1);
  });

  it('#13 keeps secret refs (never material) in the log and status output', async () => {
    const logPath = await tempLog();
    const engine = createVarEngine(fileStore(logPath), { documents, clock: counterClock() });
    const a = await engine.createRevision({ scope: SCOPE, document: DOC_A, schemaId: 'agentic-lanes/v1' });
    await engine.activate({ scope: SCOPE, revision: a.revision, expectedGeneration: 0 });

    const raw = readFileSync(logPath, 'utf8');
    // The opaque ref string is present; no resolved material ever is.
    expect(raw).toContain('secret.ops.model_a');
    expect(raw).not.toMatch(/model_a_plaintext|BEGIN PRIVATE KEY|password/i);
    expect(JSON.stringify(engine.status(SCOPE))).not.toContain('model_a_plaintext');
  });

  it('supports idempotent activate: a replayed key returns the original result without a new event', async () => {
    const engine = createVarEngine(memoryStore(), { documents, clock: counterClock() });
    const a = await engine.createRevision({ scope: SCOPE, document: DOC_A, schemaId: 'agentic-lanes/v1' });
    const first = await engine.activate({ scope: SCOPE, revision: a.revision, expectedGeneration: 0, idempotencyKey: 'k1' });
    const second = await engine.activate({ scope: SCOPE, revision: a.revision, expectedGeneration: 0, idempotencyKey: 'k1' });

    expect(second).toEqual(first);
    expect(engine.history(SCOPE).filter((event) => event.kind === 'activated')).toHaveLength(1);
  });

  it('dedupes identical content into one content-addressed revision', async () => {
    const engine = createVarEngine(memoryStore(), { documents, clock: counterClock() });
    const first = await engine.createRevision({ scope: SCOPE, document: DOC_A, schemaId: 'agentic-lanes/v1' });
    const second = await engine.createRevision({ scope: SCOPE, document: { ...DOC_A }, schemaId: 'agentic-lanes/v1' });

    expect(second.revision).toBe(first.revision);
    expect(second.created).toBe(false);
    expect(engine.history(SCOPE).filter((event) => event.kind === 'revision-created')).toHaveLength(1);
  });
});

describe('fileStore persistence', () => {
  it('#9 resumes the active head from the persisted log after a restart', async () => {
    const logPath = await tempLog();
    const engine = createVarEngine(fileStore(logPath), { documents, clock: counterClock() });
    const a = await engine.createRevision({ scope: SCOPE, document: DOC_A, schemaId: 'agentic-lanes/v1' });
    const b = await engine.createRevision({ scope: SCOPE, document: DOC_B, schemaId: 'agentic-lanes/v1' });
    await engine.activate({ scope: SCOPE, revision: a.revision, expectedGeneration: 0 });
    await engine.activate({ scope: SCOPE, revision: b.revision, expectedGeneration: 1 });

    // Fresh store instance over the same log = process restart.
    const resumed = createVarEngine(fileStore(logPath), { documents, clock: counterClock() });
    expect(resumed.status(SCOPE).generation).toBe(2);
    expect(resumed.head(SCOPE)?.values).toEqual({ [SCOPE]: DOC_B });
    // A further activation continues the monotonic sequence — never from fallback.
    const next = await resumed.activate({ scope: SCOPE, revision: a.revision, expectedGeneration: 2 });
    expect(next.generation).toBe(3);
  });

  it('replays state at a past generation (persistent store) and rejects it on an ephemeral store', async () => {
    const logPath = await tempLog();
    const engine = createVarEngine(fileStore(logPath), { documents, clock: counterClock() });
    const a = await engine.createRevision({ scope: SCOPE, document: DOC_A, schemaId: 'agentic-lanes/v1' });
    const b = await engine.createRevision({ scope: SCOPE, document: DOC_B, schemaId: 'agentic-lanes/v1' });
    await engine.activate({ scope: SCOPE, revision: a.revision, expectedGeneration: 0 });
    await engine.activate({ scope: SCOPE, revision: b.revision, expectedGeneration: 1 });

    expect(engine.replay(SCOPE, 1)?.values).toEqual({ [SCOPE]: DOC_A });
    expect(engine.replay(SCOPE, 2)?.values).toEqual({ [SCOPE]: DOC_B });

    const ephemeral = createVarEngine(memoryStore(), { documents });
    expect(() => ephemeral.replay(SCOPE, 1)).toThrow(/persistent/);
  });

  it('recovers idempotency records across a restart (append-only log is the source of truth)', async () => {
    const logPath = await tempLog();
    const engine = createVarEngine(fileStore(logPath), { documents, clock: counterClock() });
    const a = await engine.createRevision({ scope: SCOPE, document: DOC_A, schemaId: 'agentic-lanes/v1' });
    const first = await engine.activate({ scope: SCOPE, revision: a.revision, expectedGeneration: 0, idempotencyKey: 'once' });

    const resumed = createVarEngine(fileStore(logPath), { documents, clock: counterClock() });
    const replayed = await resumed.activate({ scope: SCOPE, revision: a.revision, expectedGeneration: 0, idempotencyKey: 'once' });
    expect(replayed).toEqual(first);
    // No duplicate activation appended.
    expect(resumed.history(SCOPE).filter((event) => event.kind === 'activated')).toHaveLength(1);
  });
});
