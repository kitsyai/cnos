import { afterEach, describe, expect, it } from 'vitest';

import {
  LiveVarStore,
  CnosVarNoHeadError,
  CnosVarNotModifiedError,
  type DocumentSchemaDefinition,
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
    const stop = provider.subscribe?.([{ group: 'agentic' }], (batch) => {
      received.push(batch);
      live.ingest('agentic', 'agentic', batch);
    });

    await delay(150); // let the stream establish before the activation
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'pushed' } }, 0);

    await until(() => received.length > 0);
    expect(received.length).toBeGreaterThan(0);
    expect(live.readRuntimeVar('var.agentic.lanes.vinci')).toEqual({ enabled: true, model_target_ref: 'pushed' });
    stop?.();
  });

  it('#auth failure rejects the pull when the bearer token is wrong', async () => {
    const { engine, server } = await harness(staticBearerAuthorize('good-token'));
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'r' } }, 0);

    const bad = track(providerFor(server.target, { bearerRef: 'secret.ops.token', token: 'bad-token' }));
    await expect(bad.pull({ group: 'agentic' })).rejects.toThrow();

    const good = track(providerFor(server.target, { bearerRef: 'secret.ops.token', token: 'good-token' }));
    const batch = await good.pull({ group: 'agentic' });
    expect(batch.values).toHaveProperty('agentic.lanes.vinci');
  });

  it('#reconnect resumes the subscription after a server restart', async () => {
    const store = memoryStore();
    const engine = createVarEngine(store, { documents });
    let server = await serveVarRpc(store, { engine, documents, port: 0 });
    const port = server.port;
    servers.push(server);

    const provider = track(providerFor(server.target));
    const received: VarSnapshotBatch[] = [];
    const stop = provider.subscribe?.([{ group: 'agentic' }], (batch) => received.push(batch));

    await delay(150);
    // Restart on the same port with the SAME engine so activations still notify subscribers.
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    server = await serveVarRpc(store, { engine, documents, port });
    servers.push(server);

    await delay(1200); // give the client time to reconnect (subscribe backoff)
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'after-restart' } }, 0);

    await until(() => received.length > 0, 6000);
    expect(received.length).toBeGreaterThan(0);
    expect(received[received.length - 1]?.values).toEqual({
      'agentic.lanes.vinci': { enabled: true, model_target_ref: 'after-restart' },
    });
    stop?.();
  }, 20_000);

  it('#close resolves cleanly and cancels streams', async () => {
    const { server } = await harness();
    const provider = providerFor(server.target);
    const stop = provider.subscribe?.([{ group: 'agentic' }], () => undefined);
    await delay(100);
    stop?.();
    await expect(provider.close()).resolves.toBeUndefined();
  });
});
