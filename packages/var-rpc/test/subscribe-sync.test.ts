import { afterEach, describe, expect, it } from 'vitest';

import {
  VarManager,
  type DocumentSchemaDefinition,
  type NormalizedVarSourceDefinition,
  type ProjectedVarSourceDefinition,
  type VarPushEvent,
  type VarSourceProvider,
  type VarSourceProviderContext,
} from '@kitsy/cnos-core';
import { createVarEngine, memoryStore, type VarAuthorize, type VarEngine, type VarStore } from '@kitsy/cnos-var-server';

import { createRpcVarProvider, serveVarRpc, type RunningVarRpcServer } from '../src/index.js';

/**
 * SELF-SYNCHRONIZING SUBSCRIBE (round-3 follow-up).
 *
 * Round-3 blocker 1 ("rpc reconnect never re-pulls subscribed scopes") was fixed on the CLIENT
 * side: every (re)connect reports through `onSubscriptionConnected` and the SDK re-pulls. That
 * left a server-side hole with the SAME failure mode: `attachVarRpc` registered its
 * `engine.onCommit` listener only AFTER `await authorize(...)`, so a commit landing between the
 * Subscribe request arriving and that registration completing was delivered by NEITHER the
 * stream (no hook yet) NOR the resync pull (possibly issued just before the commit). The window
 * is sub-millisecond, and losing a DEACTIVATION in it leaves a consumer serving withdrawn policy
 * with no poller to converge — subscribe-capable sources deliberately do not poll.
 *
 * The stream is now self-synchronizing: the listener is registered synchronously and buffers
 * across the authorization window, and an accepted Subscribe emits the current state as its
 * first event. These tests drive the race DETERMINISTICALLY (authorize blocks on a released
 * promise) rather than hoping to hit a sub-millisecond window, and they neutralize the client
 * resync pull where the point is that the STREAM ALONE converges.
 */

const AGENTIC_SCHEMA: DocumentSchemaDefinition = {
  fields: {
    enabled: { type: 'boolean', required: true },
    model_target_ref: { type: 'string', required: true },
  },
  additionalProperties: false,
};

const documents = { 'agentic-lanes/v1': AGENTIC_SCHEMA };
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, timeoutMs = 8000, stepMs = 10): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await delay(stepMs);
  }
  return predicate();
}

const servers: RunningVarRpcServer[] = [];
const providers: VarSourceProvider[] = [];

function track<T extends VarSourceProvider>(provider: T): T {
  providers.push(provider);
  return provider;
}

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close().catch(() => undefined)));
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

/**
 * An `authorize` hook that BLOCKS until released. `entered` counts calls that have reached the
 * await, which is the precise moment the server is inside the authorization window with its
 * commit listener already registered — so a commit issued after `entered` becomes 1 lands
 * exactly in the window under test. No sleeps, no sub-millisecond guessing.
 */
function gatedAuthorize(verdict: boolean): { authorize: VarAuthorize; entered: () => number; release: () => void } {
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    authorize: async () => {
      entered += 1;
      await gate;
      return verdict;
    },
    entered: () => entered,
    release,
  };
}

async function harness(authorize?: VarAuthorize): Promise<{
  store: VarStore;
  engine: VarEngine;
  server: RunningVarRpcServer;
}> {
  const store = memoryStore();
  const engine = createVarEngine(store, { documents });
  const server = await serveVarRpc(store, { engine, documents, ...(authorize ? { authorize } : {}) });
  servers.push(server);
  return { store, engine, server };
}

function providerFor(target: string): VarSourceProvider {
  const def: ProjectedVarSourceDefinition = { transport: 'rpc', url: target, auth: {} };
  return track(createRpcVarProvider(def, { resolveSecret: async () => '' }));
}

// ---------------------------------------------------------------------------
// 1. The authorization window
// ---------------------------------------------------------------------------

describe('a commit landing in the authorize window', () => {
  it('is BUFFERED and delivered exactly once once authorization succeeds', async () => {
    const gate = gatedAuthorize(true);
    const { engine, server } = await harness(gate.authorize);
    const provider = providerFor(server.target);

    const events: VarPushEvent[] = [];
    const stop = provider.subscribe?.([{ group: 'agentic' }], (event) => events.push(event));

    // The server is now inside `await authorize(...)`. Before the fix, its commit listener did
    // not exist yet and this commit was dropped on the floor.
    expect(await until(() => gate.entered() === 1)).toBe(true);
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'in-window' } }, 0);
    expect(events).toHaveLength(0); // nothing is written while authorization is pending

    gate.release();

    expect(await until(() => events.length > 0)).toBe(true);
    expect(events[0]?.kind).toBe('batch');
    expect(events[0]?.batch?.values).toEqual({
      'agentic.lanes.vinci': { enabled: true, model_target_ref: 'in-window' },
    });

    // EXACTLY once: the flushed buffer and the initial state carry the same revision, and the
    // initial state is deduplicated against the flush rather than repeated.
    await delay(400);
    expect(events).toHaveLength(1);

    stop?.();
  }, 30_000);

  it('is DISCARDED, unwritten, when authorization fails — and the stream still terminates', async () => {
    const gate = gatedAuthorize(false);
    const { engine, server } = await harness(gate.authorize);

    const failures: { terminal: boolean }[] = [];
    const def: ProjectedVarSourceDefinition = { transport: 'rpc', url: server.target, auth: {} };
    const provider = track(
      createRpcVarProvider(def, { resolveSecret: async () => '' }, {
        onError: (_error, info) => failures.push({ terminal: info.terminal }),
      }),
    );

    const events: VarPushEvent[] = [];
    const stop = provider.subscribe?.([{ group: 'agentic' }], (event) => events.push(event));

    expect(await until(() => gate.entered() === 1)).toBe(true);
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'refused' } }, 0);

    gate.release();

    // Terminal, per the unchanged UNAUTHENTICATED policy — not weakened by the buffering.
    expect(await until(() => failures.length > 0)).toBe(true);
    expect(failures[0]?.terminal).toBe(true);

    // And the buffered commit was discarded, never written to a refused identity.
    await delay(400);
    expect(events).toHaveLength(0);

    stop?.();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. The initial event
// ---------------------------------------------------------------------------

describe('an accepted Subscribe emits the current state first', () => {
  it('a fresh subscribe immediately receives the current head, with no commit at all', async () => {
    const { engine, server } = await harness();
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'already-live' } }, 0);

    const provider = providerFor(server.target);
    const events: VarPushEvent[] = [];
    const stop = provider.subscribe?.([{ group: 'agentic' }], (event) => events.push(event));

    // Nothing is committed after the subscribe: this can only be the initial state event.
    expect(await until(() => events.length > 0)).toBe(true);
    expect(events[0]?.kind).toBe('batch');
    expect(events[0]?.batch?.values).toEqual({
      'agentic.lanes.vinci': { enabled: true, model_target_ref: 'already-live' },
    });
    expect(events[0]?.batch?.generation).toBe(1);

    await delay(300);
    expect(events).toHaveLength(1);
    stop?.();
  }, 30_000);

  it('a subscribe to a DEACTIVATED scope immediately receives no_head', async () => {
    const { engine, server } = await harness();
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'r' } }, 0);
    await engine.deactivate({ scope: 'agentic', expectedGeneration: 1 });

    const provider = providerFor(server.target);
    const events: VarPushEvent[] = [];
    const stop = provider.subscribe?.([{ group: 'agentic' }], (event) => events.push(event));

    expect(await until(() => events.length > 0)).toBe(true);
    expect(events[0]).toEqual({ kind: 'no-head', scope: 'agentic' });
    stop?.();
  }, 30_000);

  it('a subscribe to a never-activated scope immediately receives no_head', async () => {
    const { server } = await harness();
    const provider = providerFor(server.target);
    const events: VarPushEvent[] = [];
    const stop = provider.subscribe?.([{ group: 'agentic' }], (event) => events.push(event));

    expect(await until(() => events.length > 0)).toBe(true);
    expect(events[0]).toEqual({ kind: 'no-head', scope: 'agentic' });
    stop?.();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 3. Convergence from the STREAM ALONE (client resync pull neutralized)
// ---------------------------------------------------------------------------

const staticDocument = { enabled: false, model_target_ref: 'static-tier' };

/**
 * A manager whose rpc provider is built with `onSubscriptionConnected` STRIPPED from its
 * context, so the client-side reconnect resync pull of `d50f34a` never fires. Whatever
 * convergence these tests observe therefore came from the subscription stream alone.
 */
async function streamOnlyHarness(): Promise<{
  engine: VarEngine;
  manager: VarManager;
  resyncPulls: () => number;
  down: () => Promise<void>;
  restart: () => Promise<void>;
}> {
  const store = memoryStore();
  const engine = createVarEngine(store, { documents });
  let server = await serveVarRpc(store, { engine, documents, port: 0 });
  const port = server.port;
  servers.push(server);

  let resyncPulls = 0;

  const source: NormalizedVarSourceDefinition = {
    transport: 'rpc',
    url: server.target,
    auth: {},
    // Declared deliberately: a subscribe-capable source IGNORES pollInterval (capability rule),
    // so convergence below cannot have come from a poller either.
    pollInterval: '20ms',
  };

  const manager = new VarManager({
    varSources: { ops: source },
    vars: { agentic: { source: 'ops', mode: 'prefetch' } },
    documents,
    schema: { 'var.agentic.lanes.vinci': { document: 'agentic-lanes/v1' } },
    providerModules: [
      {
        transport: 'rpc',
        create: (def, ctx) => {
          // Strip the resync seam: count invocations so the test can PROVE it was neutralized
          // rather than merely assuming so.
          const { onSubscriptionConnected: _stripped, ...rest } = ctx as VarSourceProviderContext & {
            onSubscriptionConnected?: unknown;
          };
          void _stripped;
          return track(
            createRpcVarProvider(def, {
              ...(rest as VarSourceProviderContext),
              onSubscriptionConnected: () => {
                resyncPulls += 1;
              },
            }),
          );
        },
      },
    ],
    resolveSecret: async () => '',
    warn: () => undefined,
  });

  manager.setOverlayReader((key) => (key === 'var.agentic.lanes.vinci' ? staticDocument : undefined));
  manager.setFallbackSnapshotReader((key) =>
    key === 'var.agentic.lanes.vinci'
      ? { value: staticDocument, source: 'static', freshness: 'fresh' }
      : undefined,
  );

  return {
    engine,
    manager,
    resyncPulls: () => resyncPulls,
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

describe('reconnect converges from the STREAM ALONE (resync pull neutralized)', () => {
  it('an ACTIVATION missed during the outage converges', async () => {
    const { engine, manager, resyncPulls, down, restart } = await streamOnlyHarness();

    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'before' } }, 0);
    await manager.start();
    expect(manager.readRuntimeVar('var.agentic.lanes.vinci')).toEqual({
      enabled: true,
      model_target_ref: 'before',
    });

    await delay(200);
    await down();

    // EXACTLY ONE mutation, entirely while the client is disconnected.
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'during-outage' } }, 1);

    await restart();

    expect(
      await until(
        () =>
          (manager.readRuntimeVar('var.agentic.lanes.vinci') as { model_target_ref?: string } | undefined)
            ?.model_target_ref === 'during-outage',
        15_000,
      ),
    ).toBe(true);

    // The resync seam was replaced by a counter that pulls nothing: the reconnect DID happen,
    // and no pull was issued on its behalf.
    expect(resyncPulls()).toBeGreaterThan(0);

    await manager.close();
  }, 40_000);

  it('a DEACTIVATION missed during the outage converges and falls back to the static tier', async () => {
    const { engine, manager, resyncPulls, down, restart } = await streamOnlyHarness();

    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'before' } }, 0);
    await manager.start();
    expect(manager.readRuntimeVar('var.agentic.lanes.vinci')).toEqual({
      enabled: true,
      model_target_ref: 'before',
    });

    const observed: { source: string; value: unknown }[] = [];
    manager.watch('var.agentic.lanes.vinci', (next) => observed.push({ source: next.source, value: next.value }));

    await delay(200);
    await down();

    // The worst case, and the one with NO other path to convergence: a withdrawal the client
    // never hears about, on a source that runs no poller. EXACTLY ONE mutation.
    await engine.deactivate({ scope: 'agentic', expectedGeneration: 1 });

    await restart();

    expect(await until(() => manager.readRuntimeVar('var.agentic.lanes.vinci') === undefined, 15_000)).toBe(true);
    expect(manager.status()['agentic.lanes.vinci']?.source).toBe('static');
    expect(observed).toEqual([{ source: 'static', value: staticDocument }]);
    expect(resyncPulls()).toBeGreaterThan(0);

    await manager.close();
  }, 40_000);

  it('does NOT fire a watcher when the initial event repeats the revision the client already has', async () => {
    const { engine, manager, down, restart } = await streamOnlyHarness();

    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'stable' } }, 0);
    await manager.start();

    const fires: unknown[] = [];
    manager.watch('var.agentic.lanes.vinci', (next) => fires.push(next.value));

    await delay(200);
    await down();
    // NOTHING is mutated during the outage: the reconnect's initial event necessarily carries
    // the revision already applied.
    await restart();
    await delay(1500);

    // The store gates dispatch on the content-addressed revision, so a repeated revision is not
    // a change and must wake nobody.
    expect(fires).toHaveLength(0);

    // Proof the stream and the watcher were live the whole time: a REAL change still fires once.
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'changed' } }, 1);
    expect(await until(() => fires.length > 0, 15_000)).toBe(true);
    await delay(300);
    expect(fires).toEqual([{ enabled: true, model_target_ref: 'changed' }]);

    await manager.close();
  }, 40_000);
});
