import { createServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  VarManager,
  type DocumentSchemaDefinition,
  type NormalizedVarSourceDefinition,
  type ProjectedVarSourceDefinition,
  type VarPushEvent,
  type VarSnapshotBatch,
  type VarSourceProvider,
} from '@kitsy/cnos-core';
import { createVarEngine, memoryStore, type VarAuthContext, type VarEngine, type VarStore } from '@kitsy/cnos-var-server';
import { createInMemoryVarSource } from '@kitsy/cnos-var-testkit';

import {
  createRpcVarProvider,
  serveVarRpc,
  MAX_CONSECUTIVE_SUBSCRIBE_FAILURES,
  VAR_PROTO_LOADER_OPTIONS,
  type RunningVarRpcServer,
} from '../src/index.js';

/**
 * W5b test hardening for the rpc transport and the manager/subscription seam:
 * the `scopeMatches` prefix rule W5a flagged as untested, int64 boundary behavior,
 * Subscribe auth-failure/reconnect policy, and a transport-free VarManager.startSubscriptions
 * test driven by var-testkit's in-memory source.
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

/** Poll a condition instead of sleeping a fixed interval — keeps timing-sensitive tests deterministic. */
async function until(predicate: () => boolean, timeoutMs = 8000, stepMs = 20): Promise<boolean> {
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

interface SubscriptionFailure {
  error: Error;
  terminal: boolean;
  scopes: string[];
}

/**
 * A loopback address guaranteed to refuse connections: bind an ephemeral port, record it, then
 * close the listener.
 *
 * Do NOT hardcode a low port (127.0.0.1:1) for this. Under WSL2 the localhost forwarding shim
 * swallows connections to low ports — they hang until timeout instead of returning
 * ECONNREFUSED, so a "nothing is listening" test blocks inside the RPC and never observes the
 * transport failure it is asserting on.
 */
async function deadTarget(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `127.0.0.1:${port}`;
}

function providerFor(
  target: string,
  opts: {
    bearerRef?: string;
    token?: string;
    /** Provider-level `onError` hook. */
    onError?: (error: Error, info: { terminal: boolean; scopes: string[] }) => void;
    /** SDK-level seam the VarManager supplies; feeds varStatus(). */
    onSubscriptionError?: (error: Error, info: { terminal: boolean; scopes: string[] }) => void;
  } = {},
): VarSourceProvider {
  const def: ProjectedVarSourceDefinition = {
    transport: 'rpc',
    url: target,
    auth: opts.bearerRef ? { bearer: opts.bearerRef } : {},
  };
  return createRpcVarProvider(
    def,
    {
      resolveSecret: async () => opts.token ?? '',
      ...(opts.onSubscriptionError ? { onSubscriptionError: opts.onSubscriptionError } : {}),
    },
    { ...(opts.onError ? { onError: opts.onError } : {}) },
  );
}

async function activate(engine: VarEngine, scope: string, document: unknown, expectedGeneration: number): Promise<void> {
  const created = await engine.createRevision({
    scope,
    document,
    ...(scope.includes('.') ? { schemaId: 'agentic-lanes/v1' } : {}),
  });
  await engine.activate({ scope, revision: created.revision, expectedGeneration });
}

async function harness(
  options: { authorize?: (ctx: VarAuthContext) => boolean } = {},
): Promise<{ store: VarStore; engine: VarEngine; server: RunningVarRpcServer }> {
  const store = memoryStore();
  const engine = createVarEngine(store, { documents });
  const server = await serveVarRpc(store, {
    engine,
    documents,
    ...(options.authorize ? { authorize: options.authorize } : {}),
  });
  servers.push(server);
  return { store, engine, server };
}

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
});

// ---------------------------------------------------------------------------
// scopeMatches — the prefix rule W5a flagged as untested
// ---------------------------------------------------------------------------

describe('Subscribe scope matching (the scopeMatches prefix rule)', () => {
  it('a GROUP subscription receives a KEY-scoped activation beneath it', async () => {
    const { engine, server } = await harness();
    const provider = track(providerFor(server.target));
    const received: VarSnapshotBatch[] = [];
    const stop = provider.subscribe?.([{ group: 'agentic' }], (event) => { if (event.batch) received.push(event.batch); });

    await delay(100); // let the stream establish before the first commit
    await activate(engine, 'agentic.lanes.vinci', { enabled: true, model_target_ref: 'key-scoped' }, 0);

    expect(await until(() => received.length > 0)).toBe(true);
    // The wire batch for a key scope wraps the document under the full stripped key.
    expect(received[received.length - 1]?.values).toEqual({
      'agentic.lanes.vinci': { enabled: true, model_target_ref: 'key-scoped' },
    });
    stop?.();
  }, 20_000);

  it('a GROUP subscription receives its own exact-scope activation', async () => {
    const { engine, server } = await harness();
    const provider = track(providerFor(server.target));
    const received: VarSnapshotBatch[] = [];
    const stop = provider.subscribe?.([{ group: 'agentic' }], (event) => { if (event.batch) received.push(event.batch); });

    await delay(100);
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: false, model_target_ref: 'g' } }, 0);

    expect(await until(() => received.length > 0)).toBe(true);
    expect(received[0]?.values).toHaveProperty('agentic.lanes.vinci');
    stop?.();
  }, 20_000);

  it('does NOT match a sibling scope that merely shares a string prefix without a dot boundary', async () => {
    const { engine, server } = await harness();
    const provider = track(providerFor(server.target));
    const received: VarSnapshotBatch[] = [];
    const stop = provider.subscribe?.([{ group: 'agentic' }], (event) => { if (event.batch) received.push(event.batch); });

    await delay(100);
    // `agentics` starts with `agentic` but is a different group — the rule requires a `.` boundary.
    await activate(engine, 'agentics', { 'agentics.k': 1 }, 0);
    await delay(300);
    expect(received).toHaveLength(0);

    // A real match still arrives, proving the stream was live the whole time.
    await activate(engine, 'agentic.lanes.vinci', { enabled: true, model_target_ref: 'r' }, 0);
    expect(await until(() => received.length > 0)).toBe(true);
    stop?.();
  }, 20_000);

  it('a KEY subscription does NOT receive its parent group activation', async () => {
    const { engine, server } = await harness();
    const provider = track(providerFor(server.target));
    const received: VarSnapshotBatch[] = [];
    const stop = provider.subscribe?.([{ key: 'agentic.lanes.vinci' }], (event) => { if (event.batch) received.push(event.batch); });

    await delay(100);
    // PINNED: matching is subscribed-is-a-prefix-of-committed, so a group commit does not
    // reach a key subscriber. Consumers subscribe by group; key subscriptions are narrow.
    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'r' } }, 0);
    await delay(300);
    expect(received).toHaveLength(0);

    await activate(engine, 'agentic.lanes.vinci', { enabled: true, model_target_ref: 'r' }, 0);
    expect(await until(() => received.length > 0)).toBe(true);
    stop?.();
  }, 20_000);

  it('a deactivation is FORWARDED as a no-head event (round-2 blocker 1)', async () => {
    const { engine, server } = await harness();
    const provider = track(providerFor(server.target));
    const events: VarPushEvent[] = [];
    const stop = provider.subscribe?.([{ group: 'agentic' }], (event) => events.push(event));

    // A subscribe is SELF-SYNCHRONIZING: the first event is the current state. This scope has
    // no head yet, so it is a `no-head`.
    expect(await until(() => events.length === 1)).toBe(true);
    // Initial-sync reconstruction no_head is EXACT-scope (cascade=false): the server has already
    // enumerated per-scope state, so it never transiently clears a descendant (W12).
    expect(events[0]).toEqual({ kind: 'no-head', scope: 'agentic', cascade: false });

    await activate(engine, 'agentic', { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'r' } }, 0);
    expect(await until(() => events.length === 2)).toBe(true);
    expect(events[1]?.kind).toBe('batch');

    await engine.deactivate({ scope: 'agentic', expectedGeneration: 1 });

    // This test previously PINNED the opposite: the provider dropped no_head and the SDK was
    // said to "converge on the next pull". An rpc source has no poller, so there IS no next
    // pull — the consumer served the deactivated revision indefinitely. The deactivation must
    // reach the SDK, carrying the scope it applies to.
    expect(await until(() => events.length === 3)).toBe(true);
    // A LIVE commit deactivation cascades (cascade=true): it clears the subtree as of that moment.
    expect(events[2]).toEqual({ kind: 'no-head', scope: 'agentic', cascade: true });
    stop?.();
  }, 20_000);
});

// ---------------------------------------------------------------------------
// int64 / numeric boundary
// ---------------------------------------------------------------------------

describe('int64 generation boundary at the provider edge', () => {
  it('pins longs: String on the wire with a Number() conversion at the provider edge', () => {
    expect(VAR_PROTO_LOADER_OPTIONS.longs).toBe(String);
    expect(VAR_PROTO_LOADER_OPTIONS.keepCase).toBe(true);
  });

  it('W5d/D5: a generation past Number.MAX_SAFE_INTEGER is REJECTED at the provider edge, not rounded', async () => {
    // The wire carries `generation` as an exact decimal STRING (`longs: String`); a JS number
    // is exact only to 2^53-1. Rather than committing a silently corrupted generation (which
    // would break optimistic concurrency, replay and watcher dedupe), the provider fails the
    // pull at the one place that still holds the exact text. Go carries a native int64 and
    // round-trips the same value exactly — that asymmetry is now explicit, not silent.
    const exactOnWire = '9007199254740993';
    expect(String(Number(exactOnWire))).not.toBe(exactOnWire);

    const { store, server } = await harness();
    await store.append({ kind: 'revision-created', scope: 'huge', revision: 'sha256:huge', document: { 'huge.k': 1 }, timestamp: 't' });
    await store.append({
      kind: 'activated',
      scope: 'huge',
      revision: 'sha256:huge',
      generation: Number(exactOnWire),
      timestamp: 't',
    });

    const provider = track(providerFor(server.target));
    await expect(provider.pull({ group: 'huge' })).rejects.toThrow(/outside the exactly representable range/);

    // Everything at or below the safe boundary round-trips exactly.
    for (const value of ['0', '1', '4294967296', '9007199254740991']) {
      expect(String(Number(value))).toBe(value);
    }
  }, 20_000);

  it('carries a real MAX_SAFE_INTEGER-scale generation through Pull intact', async () => {
    const { store, server } = await harness();
    // Fabricate a head at the safe boundary directly in the store's log.
    await store.append({ kind: 'revision-created', scope: 'big', revision: 'sha256:big', document: { 'big.k': 1 }, timestamp: 't' });
    await store.append({
      kind: 'activated',
      scope: 'big',
      revision: 'sha256:big',
      generation: Number.MAX_SAFE_INTEGER,
      timestamp: 't',
    });

    const provider = track(providerFor(server.target));
    const batch = await provider.pull({ group: 'big' });
    expect(batch.generation).toBe(Number.MAX_SAFE_INTEGER);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Subscribe auth failure / reconnect policy
// ---------------------------------------------------------------------------

describe('Subscribe failure policy', () => {
  it('W5d/D1: an auth-rejected Subscribe is TERMINAL and REPORTED, never silent', async () => {
    // Canonical policy (identical in the Go provider): UNAUTHENTICATED / PERMISSION_DENIED
    // are terminal — reconnecting with the same credentials can only repeat the refusal — and
    // the failure is surfaced through BOTH observable seams (the provider's `onError` and the
    // SDK's `onSubscriptionError`, which feeds varStatus()). It used to die silently: no
    // retry, no error, and — because startPollers() only covers http sources — no updates at
    // all for the process lifetime.
    let attempts = 0;
    const { server } = await harness({
      authorize: (ctx) => {
        if (ctx.kind === 'read') {
          attempts += 1;
        }
        return false;
      },
    });

    const providerErrors: SubscriptionFailure[] = [];
    const sdkErrors: SubscriptionFailure[] = [];
    const provider = track(
      providerFor(server.target, {
        bearerRef: 'secret.ops.token',
        token: 'wrong-token',
        onError: (error, info) => providerErrors.push({ error, ...info }),
        onSubscriptionError: (error, info) => sdkErrors.push({ error, ...info }),
      }),
    );
    const received: VarSnapshotBatch[] = [];
    const stop = provider.subscribe?.([{ group: 'agentic' }], (event) => { if (event.batch) received.push(event.batch); });

    // The failure is reported — to both seams — as TERMINAL.
    expect(await until(() => providerErrors.length > 0 && sdkErrors.length > 0, 8000)).toBe(true);
    expect(providerErrors[0]?.terminal).toBe(true);
    expect(providerErrors[0]?.scopes).toEqual(['agentic']);
    expect(sdkErrors[0]?.terminal).toBe(true);
    expect(String(providerErrors[0]?.error.message)).toMatch(/authoriz/i);

    // And it does not reconnect. Backoff attempt 0 is 500-1000ms, so 4s would have shown
    // several retries if the auth failure were treated as retryable.
    await delay(4000);
    expect(attempts).toBe(1);
    expect(providerErrors).toHaveLength(1);
    expect(received).toHaveLength(0);

    expect(() => stop?.()).not.toThrow();
  }, 30_000);

  it('W5d/D2: transport failures retry but are BOUNDED, ending in one terminal report', async () => {
    // Nothing listens on this target, so every attempt fails at the transport layer. Retries
    // stay retryable (non-terminal reports) until the consecutive-failure cap, then the
    // subscription goes terminal instead of reconnecting forever.
    const failures: SubscriptionFailure[] = [];
    const provider = track(
      providerFor(await deadTarget(), { onError: (error, info) => failures.push({ error, ...info }) }),
    );
    const stop = provider.subscribe?.([{ group: 'agentic' }], () => undefined);

    // Backoff is capped-exponential from 1s, so only assert the shape of the first few.
    expect(await until(() => failures.length >= 3, 12_000)).toBe(true);
    expect(failures.slice(0, 3).every((failure) => failure.terminal === false)).toBe(true);
    expect(failures.length).toBeLessThan(MAX_CONSECUTIVE_SUBSCRIBE_FAILURES);
    expect(MAX_CONSECUTIVE_SUBSCRIBE_FAILURES).toBe(8);

    expect(() => stop?.()).not.toThrow();
  }, 30_000);

  it('a Pull auth failure DOES surface as a rejected promise (unlike Subscribe)', async () => {
    const { server } = await harness({ authorize: () => false });
    const provider = track(providerFor(server.target, { bearerRef: 'secret.ops.token', token: 'wrong-token' }));
    await expect(provider.pull({ group: 'agentic' })).rejects.toThrow(/authoriz/i);
  }, 20_000);

  it('an unreachable target does not throw synchronously and stops cleanly on unsubscribe', async () => {
    const provider = track(providerFor(await deadTarget())); // nothing listening
    const received: VarSnapshotBatch[] = [];
    let stop: (() => void) | undefined;

    expect(() => {
      stop = provider.subscribe?.([{ group: 'agentic' }], (event) => { if (event.batch) received.push(event.batch); });
    }).not.toThrow();

    await delay(200);
    expect(received).toHaveLength(0);
    expect(() => stop?.()).not.toThrow();
    await expect(provider.close()).resolves.toBeUndefined();
  }, 20_000);

  it('a Pull against an unreachable target rejects rather than hanging', async () => {
    const provider = track(providerFor(await deadTarget()));
    await expect(provider.pull({ group: 'agentic' })).rejects.toBeInstanceOf(Error);
  }, 20_000);

});

// ---------------------------------------------------------------------------
// VarManager.startSubscriptions against var-testkit's in-memory source
// ---------------------------------------------------------------------------

describe('VarManager.startSubscriptions over the testkit in-memory source', () => {
  const source: NormalizedVarSourceDefinition = { transport: 'rpc', url: 'unused', auth: {} };

  function manager(provider: VarSourceProvider): VarManager {
    return new VarManager({
      varSources: { svc: source },
      vars: { agentic: { source: 'svc', mode: 'prefetch' } },
      documents,
      schema: { 'var.agentic.lanes.vinci': { document: 'agentic-lanes/v1' } },
      providerModules: [{ transport: 'rpc', create: () => provider }],
      resolveSecret: async () => 'token',
      warn: () => undefined,
    });
  }

  it('ingests an emitted activation end-to-end (activate -> emit -> ingest -> read -> watch)', async () => {
    const inMemory = createInMemoryVarSource({ documents });
    const varManager = manager(inMemory.provider);
    varManager.startSubscriptions();

    const seen: unknown[] = [];
    varManager.watch('var.agentic.lanes.vinci', (next) => seen.push(next.value));

    const document = { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'from-testkit' } };
    const created = await inMemory.engine.createRevision({ scope: 'agentic', document });
    await inMemory.engine.activate({ scope: 'agentic', revision: created.revision, expectedGeneration: 0 });
    inMemory.emit('agentic');

    expect(varManager.readRuntimeVar('var.agentic.lanes.vinci')).toEqual({
      enabled: true,
      model_target_ref: 'from-testkit',
    });
    expect(seen).toEqual([{ enabled: true, model_target_ref: 'from-testkit' }]);
    expect(varManager.status()['agentic.lanes.vinci']?.appliedGeneration).toBe(1);

    await varManager.close();
  });

  it('rejects an emitted batch that violates the bound document schema and keeps LKG', async () => {
    const inMemory = createInMemoryVarSource({ documents });
    const varManager = manager(inMemory.provider);
    varManager.startSubscriptions();

    const good = await inMemory.engine.createRevision({
      scope: 'agentic',
      document: { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'good' } },
    });
    await inMemory.engine.activate({ scope: 'agentic', revision: good.revision, expectedGeneration: 0 });
    inMemory.emit('agentic');
    expect(varManager.readRuntimeVar('var.agentic.lanes.vinci')).toMatchObject({ model_target_ref: 'good' });

    // The server-side engine validates on create; bypass it by emitting a hand-built batch so
    // the CONSUMER-side validate-before-swap is what is under test.
    const rejected = varManager.ingest('svc', 'agentic', {
      generation: 2,
      revision: 'sha256:bad',
      effectiveAt: 't',
      values: { 'agentic.lanes.vinci': { enabled: 'not-a-boolean', model_target_ref: 'bad' } },
    });
    expect(rejected.ok).toBe(false);
    expect(varManager.readRuntimeVar('var.agentic.lanes.vinci')).toMatchObject({ model_target_ref: 'good' });
    expect(varManager.status()['agentic.lanes.vinci']?.lastRejected?.revision).toBe('sha256:bad');

    await varManager.close();
  });

  it('unsubscribes on close so later emits are ignored', async () => {
    const inMemory = createInMemoryVarSource({ documents });
    const varManager = manager(inMemory.provider);
    varManager.startSubscriptions();
    await varManager.close();

    const created = await inMemory.engine.createRevision({
      scope: 'agentic',
      document: { 'agentic.lanes.vinci': { enabled: true, model_target_ref: 'after-close' } },
    });
    await inMemory.engine.activate({ scope: 'agentic', revision: created.revision, expectedGeneration: 0 });
    expect(() => inMemory.emit('agentic')).not.toThrow();
    expect(varManager.readRuntimeVar('var.agentic.lanes.vinci')).toBeUndefined();
  });

  it('W5d/D1+D2: a terminal subscription failure surfaces in varStatus() as subscription.state=failed', () => {
    // The manager wires `onSubscriptionError` into every provider it constructs, so a
    // background stream failure is observable rather than silent — and it never propagates
    // as an exception into the host process.
    let report: ((error: Error, info: { terminal: boolean; scopes: string[] }) => void) | undefined;
    const varManager = new VarManager({
      varSources: { svc: source },
      vars: { agentic: { source: 'svc', mode: 'prefetch' } },
      documents,
      schema: { 'var.agentic.lanes.vinci': { document: 'agentic-lanes/v1' } },
      providerModules: [
        {
          transport: 'rpc',
          create: (_def, ctx) => {
            report = ctx.onSubscriptionError;
            return {
              pull: () => Promise.reject(new Error('unused')),
              subscribe: () => () => undefined,
              close: async () => undefined,
            };
          },
        },
      ],
      resolveSecret: async () => 'token',
      warn: () => undefined,
    });

    varManager.startSubscriptions();
    expect(varManager.status()['agentic.lanes.vinci']?.subscription?.state).toBe('active');

    expect(() =>
      report?.(new Error('16 UNAUTHENTICATED: Not authorized for this var scope.'), {
        terminal: true,
        scopes: ['agentic'],
      }),
    ).not.toThrow();

    const status = varManager.status()['agentic.lanes.vinci'];
    expect(status?.subscription?.state).toBe('failed');
    expect(status?.subscription?.lastError).toMatch(/UNAUTHENTICATED/);
    expect(status?.lastError).toMatch(/UNAUTHENTICATED/);

    // A non-terminal drop reports as `retrying`, not `failed`.
    report?.(new Error('stream reset'), { terminal: false, scopes: ['agentic'] });
    expect(varManager.status()['agentic.lanes.vinci']?.subscription?.state).toBe('retrying');
  });

  it('emit() on a scope with no head is a no-op', () => {
    const inMemory = createInMemoryVarSource({ documents });
    expect(() => inMemory.emit('nothing-here')).not.toThrow();
  });
});
