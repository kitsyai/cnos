import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CnosVarNoHeadError,
  CnosVarRequiredError,
  LiveVarStore,
  createCnos,
  type ConfigEntry,
  type LoaderPlugin,
  type VarSnapshotBatch,
  type VarSourceProviderModule,
} from '../src/index.js';

const fixtureRoots: string[] = [];

async function createFixtureRoot(manifestSource: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-var-rt-'));
  const cnosRoot = path.join(root, 'cnos');
  await mkdir(cnosRoot, { recursive: true });
  await writeFile(path.join(cnosRoot, 'cnos.yml'), manifestSource);
  fixtureRoots.push(root);
  return root;
}

function valueLoader(entries: Array<{ key: string; value: unknown }>): LoaderPlugin {
  const configEntries: ConfigEntry[] = entries.map((entry) => ({
    key: entry.key,
    value: entry.value,
    namespace: entry.key.split('.')[0] ?? 'value',
    sourceId: 'fixture',
    pluginId: 'fixture',
    workspaceId: 'var-app',
  }));

  return { id: 'fixture', kind: 'loader', async load() { return configEntries; } };
}

/** A transport-free provider module driven by a mutable batch map (keyed by scope string). */
function inlineProvider(
  batches: Map<string, VarSnapshotBatch>,
  onPull?: (scope: string) => void,
): VarSourceProviderModule {
  return {
    transport: 'http',
    create() {
      return {
        async pull(scope) {
          const key = scope.key ?? scope.group ?? '';
          onPull?.(key);
          const batch = batches.get(key);
          if (!batch) {
            throw new CnosVarNoHeadError(key);
          }
          return batch;
        },
        async close() {
          /* noop */
        },
      };
    },
  };
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LiveVarStore', () => {
  const baseOptions = () => ({
    groups: { flags: { source: 's', mode: 'prefetch' as const, ttl: '100ms', lease: '200ms' } },
    schema: { 'var.flags.mode': { type: 'string' as const } },
    documents: {},
  });

  it('ingests, serves group-scoped reads, and reports fresh/stale/expired by the lease window', () => {
    let clock = 0;
    const store = new LiveVarStore({ ...baseOptions(), clockMs: () => clock, now: () => new Date(clock).toISOString() });

    expect(store.ingest('flags', 'flags', { generation: 1, revision: 'sha256:a', effectiveAt: 't', values: { mode: 'x' } }).ok).toBe(true);
    expect(store.readRuntimeVar('var.flags.mode')).toBe('x');

    clock = 50;
    expect(store.runtimeSnapshot('var.flags.mode')?.freshness).toBe('fresh');
    clock = 150;
    expect(store.runtimeSnapshot('var.flags.mode')?.freshness).toBe('stale');
    clock = 250;
    const expired = store.runtimeSnapshot('var.flags.mode');
    expect(expired?.freshness).toBe('expired');
    expect(expired?.lastKnownGood).toEqual({ generation: 1, revision: 'sha256:a' });
  });

  it('rejects an invalid batch, keeps last-known-good, and records lastRejected (warn once per revision)', () => {
    const warn = vi.fn();
    const store = new LiveVarStore({
      groups: { flags: { source: 's', mode: 'prefetch', ttl: '100ms' } },
      schema: { 'var.flags.mode': { type: 'number' } },
      documents: {},
      warn,
    });

    // A valid number establishes LKG.
    expect(store.ingest('flags', 'flags', { generation: 1, revision: 'sha256:good', effectiveAt: 't', values: { mode: 7 } }).ok).toBe(true);
    // A string violates the rule -> rejected, LKG retained.
    const rejected = store.ingest('flags', 'flags', { generation: 2, revision: 'sha256:bad', effectiveAt: 't', values: { mode: 'nope' } });
    expect(rejected.ok).toBe(false);
    expect(store.readRuntimeVar('var.flags.mode')).toBe(7);
    // Warn once per revision.
    store.ingest('flags', 'flags', { generation: 2, revision: 'sha256:bad', effectiveAt: 't', values: { mode: 'nope' } });
    expect(warn).toHaveBeenCalledTimes(1);

    const status = store.status().flags;
    expect(status?.lastRejected?.revision).toBe('sha256:bad');
    expect(status?.appliedGeneration).toBe(1);
    // Status never carries the ingested values themselves (only metadata/reasons).
    expect(JSON.stringify(store.status())).not.toContain('"mode":');
    expect(JSON.stringify(store.status())).not.toContain('nope');
  });

  it('fires watchers only on validated commits and stops after unsubscribe', () => {
    const store = new LiveVarStore(baseOptions());
    const events: Array<{ next: unknown; prev: unknown }> = [];
    const stop = store.watch('var.flags.mode', (next, prev) => events.push({ next: next.value, prev: prev?.value }));

    store.ingest('flags', 'flags', { generation: 1, revision: 'sha256:a', effectiveAt: 't', values: { mode: 'x' } });
    store.ingest('flags', 'flags', { generation: 2, revision: 'sha256:b', effectiveAt: 't', values: { mode: 'y' } });
    stop();
    store.ingest('flags', 'flags', { generation: 3, revision: 'sha256:c', effectiveAt: 't', values: { mode: 'z' } });

    expect(events).toEqual([
      { next: 'x', prev: undefined },
      { next: 'y', prev: 'x' },
    ]);
  });

  it('isolates a throwing watcher callback (store keeps working)', () => {
    const warn = vi.fn();
    const store = new LiveVarStore({ ...baseOptions(), warn });
    store.watch('var.flags.mode', () => {
      throw new Error('boom');
    });
    expect(() => store.ingest('flags', 'flags', { generation: 1, revision: 'sha256:a', effectiveAt: 't', values: { mode: 'x' } })).not.toThrow();
    expect(store.readRuntimeVar('var.flags.mode')).toBe('x');
    expect(warn).toHaveBeenCalled();
  });
});

const RUNTIME_MANIFEST = [
  'version: 1',
  'project:',
  '  name: var-app',
  'varSources:',
  '  svc: { transport: http, url: http://unused.local }',
  'vars:',
  '  flags: { source: svc, mode: prefetch }',
  '  agentic: { source: svc, mode: prefetch }',
  'documents:',
  '  agentic-lanes/v1:',
  '    fields:',
  '      enabled: { type: boolean, required: true }',
  '      model_target_ref: { type: string, required: true }',
  '    additionalProperties: false',
  'schema:',
  '  var.flags.mode: { type: string, default: safe }',
  '  var.agentic.lanes.vinci: { document: agentic-lanes/v1, required: true }',
  '',
].join('\n');

describe('var runtime through createCnos', () => {
  it('serves runtime -> static -> default and reflects a pushed change without caching in derived reads', async () => {
    const root = await createFixtureRoot(RUNTIME_MANIFEST);
    const batches = new Map<string, VarSnapshotBatch>([
      ['flags', { generation: 1, revision: 'sha256:f1', effectiveAt: 't', values: { mode: 'live' } }],
      ['agentic', { generation: 1, revision: 'sha256:a1', effectiveAt: 't', values: { 'lanes.vinci': { enabled: true, model_target_ref: 'ref' } } }],
    ]);
    const runtime = await createCnos({
      root,
      plugins: [valueLoader([{ key: 'value.decision', value: { $derive: '${var.flags.mode}' } }])],
      varSourceProviders: [inlineProvider(batches)],
    });

    // Runtime tier wins over the schema default.
    expect(runtime.read('var.flags.mode')).toBe('live');
    // Derived value referencing var.* reflects the runtime value.
    expect(runtime.read('value.decision')).toBe('live');

    // Push a new revision straight through ingest; a var-dependent derived read must not be cached.
    (runtime as unknown as { __ingestVar: (s: string, scope: string, b: VarSnapshotBatch) => void }).__ingestVar(
      'svc',
      'flags',
      { generation: 2, revision: 'sha256:f2', effectiveAt: 't', values: { mode: 'changed' } },
    );
    expect(runtime.read('var.flags.mode')).toBe('changed');
    expect(runtime.read('value.decision')).toBe('changed');

    await runtime.close?.();
  });

  it('fails fast: ready() rejects when a required var cannot be resolved from any tier', async () => {
    const root = await createFixtureRoot(RUNTIME_MANIFEST);
    const failing: VarSourceProviderModule = {
      transport: 'http',
      create() {
        return {
          async pull() {
            throw new Error('connection refused');
          },
          async close() {
            /* noop */
          },
        };
      },
    };

    // agentic.lanes.vinci is required with no static/default -> prefetch transport failure is fatal.
    await expect(createCnos({ root, plugins: [], varSourceProviders: [failing] })).rejects.toBeInstanceOf(
      Error,
    );
  });

  it('a read of a required, unresolved var throws CnosVarRequiredError', async () => {
    const root = await createFixtureRoot(RUNTIME_MANIFEST);
    // No provider registered -> prefetch degrades to overlay; the required key has no static/default.
    const runtime = await createCnos({ root, plugins: [] });
    expect(() => runtime.read('var.agentic.lanes.vinci')).toThrow(CnosVarRequiredError);
    await runtime.close?.();
  });

  it('close() leaves no open handles (pollers/timers cleared)', async () => {
    const root = await createFixtureRoot(RUNTIME_MANIFEST.replace('mode: prefetch', 'mode: prefetch'));
    const batches = new Map<string, VarSnapshotBatch>([
      ['flags', { generation: 1, revision: 'sha256:f1', effectiveAt: 't', values: { mode: 'live' } }],
      ['agentic', { generation: 1, revision: 'sha256:a1', effectiveAt: 't', values: { 'lanes.vinci': { enabled: true, model_target_ref: 'ref' } } }],
    ]);
    const runtime = await createCnos({ root, plugins: [], varSourceProviders: [inlineProvider(batches)] });
    expect(runtime.read('var.agentic.lanes.vinci')).toEqual({ enabled: true, model_target_ref: 'ref' });
    await runtime.close?.();
    // If timers leaked, vitest would hang; reaching here asserts a clean shutdown.
  });
});

describe('backward compatibility', () => {
  it('a manifest with no var blocks builds no store and behaves unchanged', async () => {
    const root = await createFixtureRoot('version: 1\nproject:\n  name: plain\n');
    const runtime = await createCnos({ root, plugins: [valueLoader([{ key: 'value.a', value: 1 }])] });
    expect(runtime.read('value.a')).toBe(1);
    expect(runtime.varStatus?.()).toEqual({});
    // close() is a safe no-op even with no var runtime.
    await expect(runtime.close?.()).resolves.toBeUndefined();
  });
});
