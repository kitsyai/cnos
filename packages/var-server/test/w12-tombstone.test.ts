import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DocumentSchemaDefinition } from '@kitsy/cnos-core';
import { afterEach, describe, expect, it } from 'vitest';

import { createVarEngine, fileStore, memoryStore, type VarEngine } from '../src/index.js';

/**
 * W12 — HIERARCHICAL TOMBSTONE SEMANTICS (control plane).
 *
 * A parent tombstone clears every descendant ACTIVE when the parent deactivation is committed. It
 * is NOT a persistent ancestor mask: a later child activation revives that child without parent
 * reactivation, and reactivating the parent does not resurrect tombstoned children. The subtree
 * mutation is ATOMIC (one durable event carrying the descendant scope list) and SERIALIZED against
 * child activation by the engine mutation lock.
 */

const SCHEMA: DocumentSchemaDefinition = {
  fields: {
    enabled: { type: 'boolean', required: true },
    model_target_ref: { type: 'string', required: true },
  },
  additionalProperties: false,
};
const documents = { 'agentic-lanes/v1': SCHEMA };

const G = 'agentic';
const K = 'agentic.lanes.vinci';
const S = 'agentic.lanes.orion';

const docG = { 'agentic.mode': 'fast' };
const docK = { enabled: true, model_target_ref: 'k' };
const docS = { enabled: true, model_target_ref: 's' };

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tempLog(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-var-w12-'));
  roots.push(root);
  return path.join(root, 'var-log.jsonl');
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await delay(5);
  }
  if (!predicate()) throw new Error('timed out');
}

/** Create + activate `scope` at its current generation. Group scopes carry no schema. */
async function activate(engine: VarEngine, scope: string, document: unknown, expectedGeneration: number): Promise<void> {
  const created = await engine.createRevision({
    scope,
    document,
    ...(scope.includes('.') ? { schemaId: 'agentic-lanes/v1' } : {}),
  });
  await engine.activate({ scope, revision: created.revision, expectedGeneration });
}

describe('W12 canonical histories (control plane)', () => {
  it('#1 child activation BEFORE parent deactivation is cleared (activate(g.key); deactivate(g))', async () => {
    const engine = createVarEngine(memoryStore(), { documents });
    await activate(engine, K, docK, 0);
    await engine.deactivate({ scope: G, expectedGeneration: 0 });

    // Both inactive.
    expect(engine.head(G)).toBeUndefined();
    expect(engine.head(K)).toBeUndefined();
    expect(engine.status(K).active).toBe(false);
    // The child was tombstoned with its OWN next generation (not merely masked).
    expect(engine.status(K).generation).toBe(2);
    expect(engine.status(G).generation).toBe(1);

    // Audit: the parent deactivation records which descendants it cleared…
    const parentDeact = engine.history(G).find((event) => event.kind === 'deactivated');
    expect(parentDeact?.cascade).toEqual([K]);
    // …and the child's own history faithfully records the cascade deactivation.
    const childDeacts = engine.history(K).filter((event) => event.kind === 'deactivated');
    expect(childDeacts).toHaveLength(1);
    expect(childDeacts[0]?.reason).toBe(`cascade:${G}`);
  });

  it('#2 child activation AFTER parent deactivation survives (deactivate(g); activate(g.key))', async () => {
    const engine = createVarEngine(memoryStore(), { documents });
    await engine.deactivate({ scope: G, expectedGeneration: 0 });
    await activate(engine, K, docK, 0);

    expect(engine.head(G)).toBeUndefined();
    // The parent tombstone is NOT a persistent mask — the later child is ACTIVE.
    expect(engine.head(K)?.values).toEqual({ [K]: docK });
    expect(engine.status(K).active).toBe(true);
  });

  it('#3 parent reactivation does NOT resurrect tombstoned children', async () => {
    const engine = createVarEngine(memoryStore(), { documents });
    await activate(engine, G, docG, 0);
    await activate(engine, K, docK, 0);
    await engine.deactivate({ scope: G, expectedGeneration: 1 }); // clears G and K
    expect(engine.head(K)).toBeUndefined();

    // Reactivate the PARENT only.
    await activate(engine, G, docG, 2);

    expect(engine.head(G)?.values).toEqual(docG);
    // The child stays inactive — reactivating the parent scope does not revive it.
    expect(engine.head(K)).toBeUndefined();
    expect(engine.status(K).active).toBe(false);
  });

  it('#4 a key-scoped tombstone affects only that key — never its parent or siblings', async () => {
    const engine = createVarEngine(memoryStore(), { documents });
    await activate(engine, G, docG, 0);
    await activate(engine, K, docK, 0);
    await activate(engine, S, docS, 0);

    await engine.deactivate({ scope: K, expectedGeneration: 1 });

    expect(engine.head(K)).toBeUndefined();
    // Parent and sibling untouched.
    expect(engine.head(G)?.values).toEqual(docG);
    expect(engine.head(S)?.values).toEqual({ [S]: docS });
    // A leaf deactivation carries no cascade.
    expect(engine.history(K).find((event) => event.kind === 'deactivated')?.cascade).toBeUndefined();
  });
});

describe('W12 parent-deactivation racing child-activation (both linearizations converge)', () => {
  it('#5a deactivate submitted first ⇒ the concurrently-submitted child activation survives', async () => {
    const engine = createVarEngine(memoryStore(), { documents });
    const created = await engine.createRevision({ scope: K, document: docK, schemaId: 'agentic-lanes/v1' });

    // Submission order = linearization order (the mutation lock reserves its slot synchronously).
    const d = engine.deactivate({ scope: G, expectedGeneration: 0 });
    const a = engine.activate({ scope: K, revision: created.revision, expectedGeneration: 0 });
    await Promise.all([d, a]);

    // Deactivation linearized first (K was not yet active, empty cascade); the activation follows.
    expect(engine.head(G)).toBeUndefined();
    expect(engine.head(K)?.values).toEqual({ [K]: docK });
  });

  it('#5b activate submitted first ⇒ the deactivation enumerates and clears it', async () => {
    const engine = createVarEngine(memoryStore(), { documents });
    const created = await engine.createRevision({ scope: K, document: docK, schemaId: 'agentic-lanes/v1' });

    const a = engine.activate({ scope: K, revision: created.revision, expectedGeneration: 0 });
    const d = engine.deactivate({ scope: G, expectedGeneration: 0 });
    await Promise.all([a, d]);

    // Activation linearized first (K active), so the deactivation enumerated and cleared it.
    expect(engine.head(K)).toBeUndefined();
    expect(engine.status(K).active).toBe(false);
  });

  it('#5c a child activation submitted while a subtree deactivation is mid-flight cannot interleave', async () => {
    let park!: () => void;
    const gate = new Promise<void>((resolve) => {
      park = resolve;
    });
    let parked = false;
    const engine = createVarEngine(memoryStore(), {
      documents,
      onBeforeAppend: (event) => {
        if (event.kind === 'deactivated' && event.scope === G) {
          parked = true;
          return gate;
        }
        return undefined;
      },
    });

    await activate(engine, G, docG, 0);
    const created = await engine.createRevision({ scope: K, document: docK, schemaId: 'agentic-lanes/v1' });

    // Deactivate acquires the lock, enumerates (K not active), then parks at beforeAppend.
    const d = engine.deactivate({ scope: G, expectedGeneration: 1 });
    await until(() => parked);

    // The activation is queued BEHIND the lock — it cannot commit while the deactivation is parked.
    let activated = false;
    const a = engine.activate({ scope: K, revision: created.revision, expectedGeneration: 0 }).then(() => {
      activated = true;
    });
    await delay(80);
    expect(activated).toBe(false); // proves no interleave — the mutation is serialized
    expect(engine.head(K)).toBeUndefined();

    park();
    await Promise.all([d, a]);

    // The activation linearized strictly AFTER the deactivation, so K survives.
    expect(engine.head(G)).toBeUndefined();
    expect(engine.head(K)?.values).toEqual({ [K]: docK });
  });
});

describe('W12 durable-atomic subtree deactivation (fileStore replay)', () => {
  it('a cascading deactivation replays atomically from the append-only log', async () => {
    const logPath = await tempLog();
    const engine = createVarEngine(fileStore(logPath), { documents });
    await activate(engine, G, docG, 0);
    await activate(engine, K, docK, 0);
    await engine.deactivate({ scope: G, expectedGeneration: 1 }); // one durable line clears G + K

    // Reopen the log (restart recovery): the folded state must reconstruct both scopes as inactive.
    const reopened = createVarEngine(fileStore(logPath), { documents });
    expect(reopened.head(G)).toBeUndefined();
    expect(reopened.head(K)).toBeUndefined();
    expect(reopened.status(K).active).toBe(false);
    expect(reopened.status(K).generation).toBe(2);
    // The subtree list survived the round-trip on the parent event.
    expect(reopened.history(G).find((event) => event.kind === 'deactivated')?.cascade).toEqual([K]);
  });
});
