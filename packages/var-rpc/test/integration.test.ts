import { afterEach, describe, expect, it } from 'vitest';

import {
  LiveVarStore,
  CnosVarNoHeadError,
  CnosVarNotModifiedError,
  VarManager,
  type DocumentSchemaDefinition,
  type NormalizedVarSourceDefinition,
  type ProjectedVarSourceDefinition,
  type VarSnapshotBatch,
  type VarSourceProvider,
} from '@kitsy/cnos-core';
import {
  createVarEngine,
  memoryStore,
  staticBearerAuthorize,
  type VarEngine,
  type VarStore,
} from '@kitsy/cnos-var-server';

import { createRpcVarProvider, serveVarRpc, VAR_PROTO_LOADER_OPTIONS, type RunningVarRpcServer } from '../src/index.js';

const AGENTIC_SCHEMA: DocumentSchemaDefinition = {
  fields: {
    enabled: { type: 'boolean', required: true },
    model_target_ref: { type: 'string', required: true },
  },
  additionalProperties: false,
};

const documents = { 'agentic-lanes/v1': AGENTIC_SCHEMA };
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, timeoutMs = 4000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await delay(stepMs);
  }
}

async function activate(engine: VarEngine, scope: string, document: unknown, expectedGeneration: number): Promise<void> {
  const created = await engine.createRevision({
    scope,
    document,
    ...(scope.includes('.') ? { schemaId: 'agentic-lanes/v1' } : {}),
  });
  await engine.activate({ scope, revision: created.revision, expectedGeneration });
}

function providerFor(target: string, opts: { bearerRef?: string; token?: string } = {}): VarSourceProvider {
  const def: ProjectedVarSourceDefinition = {
    transport: 'rpc',
    url: target,
    auth: opts.bearerRef ? { bearer: opts.bearerRef } : {},
  };
  return createRpcVarProvider(def, { resolveSecret: async () => opts.token ?? '' });
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

async function harness(authorize?: ReturnType<typeof staticBearerAuthorize>): Promise<{
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

describe('var rpc transport', () => {
  it('pins proto-loader decode options (keepCase + int64 as number at the edge)', async () => {
    expect(VAR_PROTO_LOADER_OPTIONS.keepCase).toBe(true);

    const { engine, server } = await harness();
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'r' } }, 0);
    const provider = track(providerFor(server.target));

    const batch = await provider.pull({ group: 'agentic' });
    expect(typeof batch.generation).toBe('number');
    expect(batch.generation).toBe(1);
  });

  it('#pull fresh returns the canonical head batch keyed by full stripped key', async () => {
    const { engine, server } = await harness();
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'runtime-ref' } }, 0);
    const provider = track(providerFor(server.target));

    const batch = await provider.pull({ group: 'agentic' });
    expect(batch.revision).toMatch(/^sha256:/);
    expect(batch.values).toEqual({ 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'runtime-ref' } });
  });

  it('#pull not_modified throws CnosVarNotModifiedError (like http 304)', async () => {
    const { engine, server } = await harness();
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'r' } }, 0);
    const provider = track(providerFor(server.target));

    const fresh = await provider.pull({ group: 'agentic' });
    await expect(provider.pull({ group: 'agentic' }, fresh.revision)).rejects.toBeInstanceOf(CnosVarNotModifiedError);
  });

  it('#pull no_head throws CnosVarNoHeadError (like http 404 no-head)', async () => {
    const { server } = await harness();
    const provider = track(providerFor(server.target));

    await expect(provider.pull({ group: 'agentic' })).rejects.toBeInstanceOf(CnosVarNoHeadError);
  });

  it('#subscribe delivers an activation end-to-end (activate -> onBatch -> ingest -> read)', async () => {
    const { engine, server } = await harness();
    const provider = track(providerFor(server.target));

    const live = new LiveVarStore({
      groups: { agentic: { source: 'ops', mode: 'prefetch', lease: '10m' } },
      schema: { 'var.agentic.lanes.vinci': { document: 'agentic-lanes/v1', required: true } },
      documents,
    });

    const received: VarSnapshotBatch[] = [];
    const stop = provider.subscribe?.([{ group: 'agentic' }], (event) => {
      if (!event.batch) {
        return;
      }
      received.push(event.batch);
      live.ingest('agentic', 'agentic', event.batch);
    });

    await delay(150); // let the stream establish before the activation
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'pushed' } }, 0);

    await until(() => received.length > 0);
    expect(received.length).toBeGreaterThan(0);
    expect(live.readRuntimeVar('var.agentic.lanes.vinci')).toEqual({ enabled: true, model_target_ref: 'pushed' });
    stop?.();
  });

  it('#15 a DEACTIVATION over rpc restores the static tier, with no poller in the picture', async () => {
    // Round-2 blocker 1, rpc half — the worst case: an rpc source has no poller, so if the
    // no_head push is dropped there is nothing left to converge on and the deactivated revision
    // is served forever. Driven through the real gRPC transport and the real engine, via the
    // full VarManager (so the SDK's push routing is exercised, not just the provider).
    const { engine, server } = await harness();
    const source: NormalizedVarSourceDefinition = {
      transport: 'rpc',
      url: server.target,
      auth: {},
      // Declared deliberately: a subscribe-capable source must IGNORE pollInterval (capability
      // rule), so the fallback below can only have come from the pushed deactivation.
      pollInterval: '20ms',
    };
    const manager = new VarManager({
      varSources: { ops: source },
      vars: { agentic: { source: 'ops', mode: 'prefetch' } },
      documents,
      schema: { 'var.agentic.lanes.vinci': { document: 'agentic-lanes/v1' } },
      providerModules: [{ transport: 'rpc', create: (def, ctx) => track(createRpcVarProvider(def, ctx)) }],
      resolveSecret: async () => '',
      warn: () => undefined,
    });

    const staticDocument = { enabled: false, model_target_ref: 'static-tier' };
    manager.setOverlayReader((key) =>
      key === 'var.agentic.lanes.vinci' ? staticDocument : undefined,
    );
    manager.setFallbackSnapshotReader((key) =>
      key === 'var.agentic.lanes.vinci'
        ? { value: staticDocument, source: 'static', freshness: 'fresh' }
        : undefined,
    );

    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'runtime-tier' } }, 0);
    await manager.start();

    expect(manager.readRuntimeVar('var.agentic.lanes.vinci')).toEqual({
      enabled: true,
      model_target_ref: 'runtime-tier',
    });

    const observed: Array<{ source: string; value: unknown }> = [];
    manager.watch('var.agentic.lanes.vinci', (next) => observed.push({ source: next.source, value: next.value }));

    await delay(200); // let the subscription establish
    await engine.deactivate({ scope: 'agentic', expectedGeneration: 1 });

    await until(() => manager.readRuntimeVar('var.agentic.lanes.vinci') === undefined);
    expect(manager.readRuntimeVar('var.agentic.lanes.vinci')).toBeUndefined();
    expect(observed).toEqual([{ source: 'static', value: staticDocument }]);

    const status = manager.status()['agentic.lanes.vinci'];
    expect(status?.source).toBe('static');
    expect(status?.appliedGeneration).toBe(0);
    expect(status?.desiredGeneration).toBeUndefined();

    await manager.close();
  }, 20_000);

  it('#auth failure rejects the pull when the bearer token is wrong', async () => {
    const { engine, server } = await harness(staticBearerAuthorize('good-token'));
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'r' } }, 0);

    const bad = track(providerFor(server.target, { bearerRef: 'secret.ops.token', token: 'bad-token' }));
    await expect(bad.pull({ group: 'agentic' })).rejects.toThrow();

    const good = track(providerFor(server.target, { bearerRef: 'secret.ops.token', token: 'good-token' }));
    const batch = await good.pull({ group: 'agentic' });
    expect(batch.values).toHaveProperty('agentic.lanes.vinci');
  });

  /**
   * Round-3 blocker 1. The ADR promises "on reconnect, re-pull subscribed scopes with known
   * revisions to converge". Neither SDK did it: the client only reopened the stream, and the
   * server forwards FUTURE commits only — so anything that happened during the outage was lost
   * permanently. Since round 2 made deactivation a real state change, a missed deactivation
   * means serving withdrawn policy forever, and an rpc source has no poller to recover with.
   *
   * The mutation happens EXACTLY ONCE, while the server is down, and nothing is mutated after
   * the reconnect. The old "keep activating until something lands" loop could not fail here.
   */
  async function resyncHarness(): Promise<{
    engine: VarEngine;
    manager: VarManager;
    restart: () => Promise<void>;
    down: () => Promise<void>;
  }> {
    const store = memoryStore();
    const engine = createVarEngine(store, { documents });
    let server = await serveVarRpc(store, { engine, documents, port: 0 });
    const port = server.port;
    servers.push(server);

    const source: NormalizedVarSourceDefinition = {
      transport: 'rpc',
      url: server.target,
      auth: {},
      // Declared deliberately: a subscribe-capable source IGNORES pollInterval (capability
      // rule), so convergence below can only have come from the reconnect resync.
      pollInterval: '20ms',
    };
    const manager = new VarManager({
      varSources: { ops: source },
      vars: { agentic: { source: 'ops', mode: 'prefetch' } },
      documents,
      schema: { 'var.agentic.lanes.vinci': { document: 'agentic-lanes/v1' } },
      providerModules: [{ transport: 'rpc', create: (def, ctx) => track(createRpcVarProvider(def, ctx)) }],
      resolveSecret: async () => '',
      warn: () => undefined,
    });

    const staticDocument = { enabled: false, model_target_ref: 'static-tier' };
    manager.setOverlayReader((key) =>
      key === 'var.agentic.lanes.vinci' ? staticDocument : undefined,
    );
    manager.setFallbackSnapshotReader((key) =>
      key === 'var.agentic.lanes.vinci'
        ? { value: staticDocument, source: 'static', freshness: 'fresh' }
        : undefined,
    );

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

  it('#reconnect re-pulls subscribed scopes: an ACTIVATION missed during the outage converges', async () => {
    const { engine, manager, down, restart } = await resyncHarness();

    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'before' } }, 0);
    await manager.start();
    expect(manager.readRuntimeVar('var.agentic.lanes.vinci')).toEqual({
      enabled: true,
      model_target_ref: 'before',
    });

    await delay(200); // let the subscription establish
    await down();

    // EXACTLY ONE mutation, entirely while the client is disconnected.
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'during-outage' } }, 1);

    await restart();

    await until(
      () =>
        (manager.readRuntimeVar('var.agentic.lanes.vinci') as { model_target_ref?: string } | undefined)
          ?.model_target_ref === 'during-outage',
      15_000,
    );
    expect(manager.readRuntimeVar('var.agentic.lanes.vinci')).toEqual({
      enabled: true,
      model_target_ref: 'during-outage',
    });

    await manager.close();
  }, 30_000);

  it('#reconnect re-pulls subscribed scopes: a DEACTIVATION missed during the outage converges', async () => {
    const { engine, manager, down, restart } = await resyncHarness();

    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'before' } }, 0);
    await manager.start();
    expect(manager.readRuntimeVar('var.agentic.lanes.vinci')).toEqual({
      enabled: true,
      model_target_ref: 'before',
    });

    await delay(200);
    await down();

    // The worst case: a withdrawal the client never hears about. EXACTLY ONE mutation.
    await engine.deactivate({ scope: 'agentic', expectedGeneration: 1 });

    await restart();

    await until(() => manager.readRuntimeVar('var.agentic.lanes.vinci') === undefined, 15_000);
    expect(manager.readRuntimeVar('var.agentic.lanes.vinci')).toBeUndefined();
    expect(manager.status()['agentic.lanes.vinci']?.source).toBe('static');

    await manager.close();
  }, 30_000);

  it('#close resolves cleanly and cancels streams', async () => {
    const { server } = await harness();
    const provider = providerFor(server.target);
    const stop = provider.subscribe?.([{ group: 'agentic' }], () => undefined);
    await delay(100);
    stop?.();
    await expect(provider.close()).resolves.toBeUndefined();
  });
});
