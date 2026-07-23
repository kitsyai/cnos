import { afterEach, describe, expect, it } from 'vitest';

import {
  CnosVarNoHeadError,
  VarManager,
  type DocumentSchemaDefinition,
  type NormalizedVarSourceDefinition,
  type ResolvedVarSnapshot,
  type VarPushEvent,
  type VarSourceProviderContext,
} from '@kitsy/cnos-core';
import { createVarEngine, memoryStore, type VarEngine } from '@kitsy/cnos-var-server';

import { createRpcVarProvider, serveVarRpc, type RunningVarRpcServer } from '../src/index.js';

/**
 * W12 — HIERARCHICAL TOMBSTONE DELIVERY. Every consumption path (live, fresh subscription,
 * reconnect) must converge to the SAME state for each canonical history, and a reconstruction must
 * NEVER apply a cascading parent no_head that momentarily clears a child it is about to restore.
 */

const AGENTIC_SCHEMA: DocumentSchemaDefinition = {
  fields: {
    enabled: { type: 'boolean', required: true },
    model_target_ref: { type: 'string', required: true },
  },
  additionalProperties: false,
};
const documents = { 'agentic-lanes/v1': AGENTIC_SCHEMA };

const G = 'agentic';
const K = 'agentic.lanes.vinci';
const MODE_KEY = 'var.agentic.mode';
const CHILD_KEY = 'var.agentic.lanes.vinci';

const docG = { 'agentic.mode': 'fast' };
const docK = { enabled: true, model_target_ref: 'k' };
const staticChild = { enabled: false, model_target_ref: 'static' };

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await delay(10);
  }
  return predicate();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const servers: RunningVarRpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
});

async function activate(engine: VarEngine, scope: string, document: unknown, expectedGeneration: number): Promise<void> {
  const created = await engine.createRevision({
    scope,
    document,
    ...(scope.includes('.') ? { schemaId: 'agentic-lanes/v1' } : {}),
  });
  await engine.activate({ scope, revision: created.revision, expectedGeneration });
}

function fallbackSnapshot(key: string): ResolvedVarSnapshot | undefined {
  if (key === CHILD_KEY) return { value: staticChild, source: 'static', freshness: 'fresh' };
  if (key === MODE_KEY) return { value: 'static-mode', source: 'static', freshness: 'fresh' };
  return undefined;
}

interface Harness {
  engine: VarEngine;
  manager: VarManager;
  down: () => Promise<void>;
  restart: () => Promise<void>;
}

/** A full manager over a shared engine + restartable rpc server (same port across restarts). */
async function harness(seed?: (engine: VarEngine) => Promise<void>): Promise<Harness> {
  const store = memoryStore();
  const engine = createVarEngine(store, { documents });
  if (seed) await seed(engine);

  let server = await serveVarRpc(store, { engine, documents, port: 0 });
  const port = server.port;
  servers.push(server);

  const source: NormalizedVarSourceDefinition = { transport: 'rpc', url: server.target, auth: {} };
  const manager = new VarManager({
    varSources: { ops: source },
    vars: { agentic: { source: 'ops', mode: 'prefetch' } },
    documents,
    schema: { 'var.agentic.mode': { type: 'string' }, 'var.agentic.lanes.vinci': { document: 'agentic-lanes/v1' } },
    providerModules: [{ transport: 'rpc', create: (def, ctx) => createRpcVarProvider(def, ctx) }],
    resolveSecret: async () => '',
    warn: () => undefined,
  });
  manager.setOverlayReader((key) => fallbackSnapshot(key)?.value);
  manager.setFallbackSnapshotReader(fallbackSnapshot);

  return {
    engine,
    manager,
    down: async () => {
      await server.close();
      servers.splice(servers.indexOf(server), 1);
    },
    restart: async () => {
      server = await serveVarRpc(store, { engine, documents, port });
      servers.push(server);
    },
  };
}

const readChild = (manager: VarManager): unknown => manager.readRuntimeVar(CHILD_KEY);
const childSource = (manager: VarManager): string | undefined => manager.status()['agentic.lanes.vinci']?.source;

describe('W12 fresh subscription reconstructs each canonical history', () => {
  it('#1 activate(g.key); deactivate(g) ⇒ child falls back to static', async () => {
    const { manager } = await harness(async (engine) => {
      await activate(engine, K, docK, 0);
      await engine.deactivate({ scope: G, expectedGeneration: 0 });
    });
    await manager.start();
    expect(await until(() => childSource(manager) === 'static')).toBe(true);
    expect(readChild(manager)).toBeUndefined();
    await manager.close();
  }, 30_000);

  it('#2 deactivate(g); activate(g.key) ⇒ child ACTIVE (parent tombstone is not a mask)', async () => {
    const { manager } = await harness(async (engine) => {
      await engine.deactivate({ scope: G, expectedGeneration: 0 });
      await activate(engine, K, docK, 0);
    });
    await manager.start();
    expect(await until(() => JSON.stringify(readChild(manager)) === JSON.stringify(docK))).toBe(true);
    expect(childSource(manager)).toBe('runtime');
    await manager.close();
  }, 30_000);

  it('#3 …; deactivate(g); activate(g) ⇒ parent active, child NOT resurrected', async () => {
    const { manager } = await harness(async (engine) => {
      await activate(engine, G, docG, 0);
      await activate(engine, K, docK, 0);
      await engine.deactivate({ scope: G, expectedGeneration: 1 });
      await activate(engine, G, docG, 2);
    });
    await manager.start();
    // Parent key is served from runtime again…
    expect(await until(() => manager.readRuntimeVar(MODE_KEY) === 'fast')).toBe(true);
    // …but the tombstoned child stays on the static tier.
    expect(readChild(manager)).toBeUndefined();
    expect(childSource(manager)).toBe('static');
    await manager.close();
  }, 30_000);
});

describe('W12 explicit tombstone vs never-authored parent (initial sync)', () => {
  it('#10 a never-authored parent with an active child reconstructs the child with no transient clear', async () => {
    // g was NEVER deactivated; only the child scope was authored. The initial sync must not emit a
    // synthetic parent no_head that would cascade-clear the child.
    const { manager } = await harness(async (engine) => {
      await activate(engine, K, docK, 0);
    });
    await manager.start();
    expect(await until(() => JSON.stringify(readChild(manager)) === JSON.stringify(docK))).toBe(true);
    await manager.close();
  }, 30_000);
});

describe('W12 reconnect reconstructs without a transient fallback watcher event', () => {
  it('#7/#9 a child active under an explicitly tombstoned parent survives a reconnect, watcher never sees the fallback', async () => {
    // History 2 state: g deactivated, then g.key activated. The client holds g.key active.
    const h = await harness(async (engine) => {
      await engine.deactivate({ scope: G, expectedGeneration: 0 });
      await activate(engine, K, docK, 0);
    });
    await h.manager.start();
    expect(await until(() => JSON.stringify(readChild(h.manager)) === JSON.stringify(docK))).toBe(true);

    const observed: Array<{ source: string; value: unknown }> = [];
    h.manager.watch(CHILD_KEY, (next) => observed.push({ source: next.source, value: next.value }));

    // Force a reconnect. On reconnect the server reconstructs: an EXACT no_head for the tombstoned
    // parent 'agentic' (exact_scope=true) followed by the still-active child head. The exact no_head
    // must NOT clear the child.
    await h.down();
    await h.restart();

    // Give the reconnect + resync ample time to (mis)behave.
    await delay(1500);

    expect(readChild(h.manager)).toEqual(docK);
    expect(childSource(h.manager)).toBe('runtime');
    // The crux: NO transient fallback fire. The child never left the runtime tier.
    expect(observed).toEqual([]);
    await h.manager.close();
  }, 40_000);
});

describe('W12 pull resync racing stream delivery', () => {
  it.each(['stream-first', 'pull-first'] as const)(
    '#8 deterministically converges with %s completion',
    async (order) => {
      let pullCalls = 0;
      let push: ((event: VarPushEvent) => void) | undefined;
      let providerContext: VarSourceProviderContext | undefined;
      const pullEntered = deferred();
      const releasePull = deferred();
      const pullReturned = deferred();
      const nextDoc = { enabled: true, model_target_ref: `k-${order}` };

      const manager = new VarManager({
        varSources: { ops: { transport: 'rpc', url: 'in-process', auth: {} } },
        vars: { agentic: { source: 'ops', mode: 'prefetch' } },
        documents,
        schema: {
          'var.agentic.mode': { type: 'string' },
          'var.agentic.lanes.vinci': { document: 'agentic-lanes/v1' },
        },
        providerModules: [{
          transport: 'rpc',
          create: (_definition, context) => {
            providerContext = context;
            return {
              pull: async (scope) => {
                pullCalls += 1;
                const scopeString = scope.key ?? scope.group ?? G;
                if (pullCalls === 1) {
                  throw new CnosVarNoHeadError(scopeString);
                }
                pullEntered.resolve();
                await releasePull.promise;
                pullReturned.resolve();
                throw new CnosVarNoHeadError(scopeString);
              },
              subscribe: (_scopes, onEvent) => {
                push = onEvent;
                return () => undefined;
              },
              close: async () => undefined,
            };
          },
        }],
        resolveSecret: async () => '',
        warn: () => undefined,
      });
      manager.setOverlayReader((key) => fallbackSnapshot(key)?.value);
      manager.setFallbackSnapshotReader(fallbackSnapshot);

      await manager.start();
      expect(push).toBeTypeOf('function');
      expect(providerContext?.onSubscriptionConnected).toBeTypeOf('function');

      push?.({
        kind: 'batch',
        scope: K,
        batch: {
          generation: 1,
          revision: 'sha256:before-reconnect',
          effectiveAt: '2026-07-20T00:00:00.000Z',
          values: { [K]: docK },
        },
      });
      expect(await until(() => JSON.stringify(readChild(manager)) === JSON.stringify(docK))).toBe(true);

      const observed: unknown[] = [];
      manager.watch(CHILD_KEY, (next) => observed.push(next.value));

      providerContext?.onSubscriptionConnected?.([G], { reconnect: true });
      await pullEntered.promise;

      const deliverChild = (): void => {
        push?.({
          kind: 'batch',
          scope: K,
          batch: {
            generation: 2,
            revision: `sha256:${order}`,
            effectiveAt: '2026-07-20T00:00:01.000Z',
            values: { [K]: nextDoc },
          },
        });
      };

      if (order === 'stream-first') {
        deliverChild();
        expect(readChild(manager)).toEqual(nextDoc);
        releasePull.resolve();
        await pullReturned.promise;
        await delay(0);
      } else {
        releasePull.resolve();
        await pullReturned.promise;
        await delay(0);
        deliverChild();
      }

      expect(pullCalls).toBe(2);
      expect(readChild(manager)).toEqual(nextDoc);
      expect(childSource(manager)).toBe('runtime');
      expect(observed).not.toContainEqual(staticChild);
      await manager.close();
    },
  );
});
