import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LiveVarStore,
  VarManager,
  createCnos,
  isVarGroupScope,
  isVarKeyScope,
  resolveVarOverlay,
  toCanonicalVarValues,
  toValueOverlayKey,
  type ConfigEntry,
  type LoaderPlugin,
  type NormalizedVarSourceDefinition,
  type ResolvedVarSnapshot,
  type VarSnapshotBatch,
  type VarSourceProvider,
  type VarSourceProviderModule,
} from '../src/index.js';

/**
 * W5b test hardening: adversarial / edge / regression coverage for the `var.*` stack that the
 * feature-phase suites (`var-runtime.test.ts`, `var-runtime-store.test.ts`) do not reach.
 *
 * Several tests here PIN current behavior where the design doc is silent or ambiguous. Those
 * are marked `PINNED:` and are the contract until a design decision changes them deliberately.
 */

const roots: string[] = [];

async function fixtureRoot(manifest: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-var-edge-'));
  await mkdir(path.join(root, 'cnos'), { recursive: true });
  await writeFile(path.join(root, 'cnos', 'cnos.yml'), manifest);
  roots.push(root);
  return root;
}

function valueLoader(entries: Array<{ key: string; value: unknown }>): LoaderPlugin {
  const configEntries: ConfigEntry[] = entries.map((entry) => ({
    key: entry.key,
    value: entry.value,
    namespace: entry.key.split('.')[0] ?? 'value',
    sourceId: 'fixture',
    pluginId: 'fixture',
    workspaceId: 'var-edge',
  }));
  return { id: 'fixture', kind: 'loader', async load() { return configEntries; } };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function batch(overrides: Partial<VarSnapshotBatch> & { values: Record<string, unknown> }): VarSnapshotBatch {
  return {
    generation: 1,
    revision: 'sha256:r1',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. Acceptance matrix — consumer-SDK-side items
// ---------------------------------------------------------------------------

describe('acceptance matrix (consumer plane)', () => {
  it('acceptance #1: static fallback applies with no runtime revision, and each tier in order', () => {
    const manifest = {
      schema: {
        'var.flags.mode': { type: 'string' as const, default: 'from-default' },
        'var.flags.other': { type: 'string' as const },
      },
    } as never;

    const values: Record<string, unknown> = { 'value.flags.mode': 'from-static' };
    const runtime: Record<string, unknown> = {};

    const context = {
      readRuntimeVar: (key: string) => runtime[key],
      readValue: (key: string) => values[key],
      manifest,
    };

    // ② static tier when there is no runtime revision.
    expect(resolveVarOverlay('var.flags.mode', context)).toBe('from-static');
    // ③ schema default when neither runtime nor static exists.
    delete values['value.flags.mode'];
    expect(resolveVarOverlay('var.flags.mode', context)).toBe('from-default');
    // ④ undefined when nothing at all is declared.
    expect(resolveVarOverlay('var.flags.other', context)).toBeUndefined();
    // ① runtime tier wins over both when present.
    runtime['var.flags.mode'] = 'from-runtime';
    expect(resolveVarOverlay('var.flags.mode', context)).toBe('from-runtime');
  });

  it('acceptance #1: an explicit runtime `null` still wins the overlay (null !== absent)', () => {
    const manifest = { schema: { 'var.flags.mode': { type: 'string' as const, default: 'd' } } } as never;
    expect(
      resolveVarOverlay('var.flags.mode', {
        readRuntimeVar: () => null,
        readValue: () => 'static',
        manifest,
      }),
    ).toBeNull();
  });

  it('acceptance #15: static -> runtime -> static flips by activation alone, no redeploy', () => {
    const store = new LiveVarStore({
      groups: { flags: { source: 's', mode: 'prefetch' } },
      schema: { 'var.flags.mode': { type: 'string' } },
      documents: {},
    });
    const manifest = { schema: { 'var.flags.mode': { type: 'string', default: 'safe' } } } as never;
    const read = (): unknown =>
      resolveVarOverlay('var.flags.mode', {
        readRuntimeVar: (key) => store.readRuntimeVar(key),
        readValue: () => 'static-tier',
        manifest,
      });

    expect(read()).toBe('static-tier');
    store.ingest('flags', 'flags', batch({ values: { 'flags.mode': 'runtime-tier' } }));
    expect(read()).toBe('runtime-tier');
    // "Deactivation" delivers a batch with the key absent — the overlay falls back with no restart.
    store.ingest('flags', 'flags', batch({ generation: 2, revision: 'sha256:r2', values: {} }));
    expect(read()).toBe('static-tier');
  });

  it('acceptance #3: a rejected multi-key batch commits NOTHING (no mixed snapshot)', () => {
    const warn = vi.fn();
    const store = new LiveVarStore({
      groups: { flags: { source: 's', mode: 'prefetch' } },
      schema: { 'var.flags.a': { type: 'string' }, 'var.flags.b': { type: 'number' } },
      documents: {},
      warn,
    });

    store.ingest('flags', 'flags', batch({ values: { 'flags.a': 'one', 'flags.b': 1 } }));
    // `flags.b` is invalid; `flags.a` in the SAME batch must not land either.
    const rejected = store.ingest(
      'flags',
      'flags',
      batch({ generation: 2, revision: 'sha256:r2', values: { 'flags.a': 'two', 'flags.b': 'not-a-number' } }),
    );

    expect(rejected.ok).toBe(false);
    expect(store.readRuntimeVar('var.flags.a')).toBe('one');
    expect(store.readRuntimeVar('var.flags.b')).toBe(1);
  });

  it('acceptance #3: a watcher reading mid-notify observes the fully committed batch', () => {
    const store = new LiveVarStore({
      groups: { flags: { source: 's', mode: 'prefetch' } },
      schema: { 'var.flags.a': { type: 'string' }, 'var.flags.b': { type: 'string' } },
      documents: {},
    });
    const observed: Array<[unknown, unknown]> = [];
    store.watch('var.flags.a', () => {
      observed.push([store.readRuntimeVar('var.flags.a'), store.readRuntimeVar('var.flags.b')]);
    });

    store.ingest('flags', 'flags', batch({ values: { 'flags.a': 'A', 'flags.b': 'B' } }));
    expect(observed).toEqual([['A', 'B']]);
  });

  it('acceptance #10/#11: within the lease the snapshot serves LKG; past it, freshness is expired', () => {
    let clock = 0;
    const store = new LiveVarStore({
      groups: { flags: { source: 's', mode: 'prefetch', ttl: '100ms', lease: '500ms' } },
      schema: { 'var.flags.mode': { type: 'string' } },
      documents: {},
      clockMs: () => clock,
      now: () => new Date(clock).toISOString(),
    });
    store.ingest('flags', 'flags', batch({ values: { 'flags.mode': 'live' } }));

    clock = 400; // network is "down"; nothing new ingested
    const stale = store.runtimeSnapshot('var.flags.mode');
    expect(stale?.value).toBe('live'); // #10 last-known-good still served
    expect(stale?.freshness).toBe('stale');

    clock = 900;
    const expired = store.runtimeSnapshot('var.flags.mode');
    expect(expired?.value).toBe('live');
    expect(expired?.freshness).toBe('expired'); // #11 visible to the consumer
    expect(store.status().flags?.freshness).toBe('expired'); // ...and in varStatus()
  });
});

// ---------------------------------------------------------------------------
// B. Freshness / temporal edges
// ---------------------------------------------------------------------------

describe('freshness and lease boundaries', () => {
  function freshnessAt(age: number, group: { ttl?: string; lease?: string }): string | undefined {
    let clock = 0;
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch', ...group } },
      schema: { 'var.g.k': { type: 'string' } },
      documents: {},
      clockMs: () => clock,
      now: () => new Date(clock).toISOString(),
    });
    store.ingest('g', 'g', batch({ values: { 'g.k': 'v' } }));
    clock = age;
    return store.runtimeSnapshot('var.g.k')?.freshness;
  }

  it('is fresh EXACTLY at the ttl edge and stale one tick past it (strict >)', () => {
    expect(freshnessAt(100, { ttl: '100ms' })).toBe('fresh');
    expect(freshnessAt(101, { ttl: '100ms' })).toBe('stale');
  });

  it('is stale EXACTLY at the lease edge and expired one tick past it (strict >)', () => {
    expect(freshnessAt(500, { ttl: '100ms', lease: '500ms' })).toBe('stale');
    expect(freshnessAt(501, { ttl: '100ms', lease: '500ms' })).toBe('expired');
  });

  it('with neither ttl nor lease declared, a snapshot never ages out', () => {
    expect(freshnessAt(0, {})).toBe('fresh');
    expect(freshnessAt(Number.MAX_SAFE_INTEGER, {})).toBe('fresh');
  });

  it('PINNED: a zero lease expires the snapshot immediately on the next tick', () => {
    // parseDuration('0ms') === 0, which is `!== undefined`, so the lease branch engages.
    expect(freshnessAt(0, { lease: '0ms' })).toBe('fresh');
    expect(freshnessAt(1, { lease: '0ms' })).toBe('expired');
  });

  it('PINNED: a zero ttl makes the snapshot stale immediately on the next tick', () => {
    expect(freshnessAt(0, { ttl: '0s' })).toBe('fresh');
    expect(freshnessAt(1, { ttl: '0s' })).toBe('stale');
  });

  it('PINNED: clock skew (observedAt in the future) yields a negative age and reports fresh', () => {
    let clock = 10_000;
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch', ttl: '100ms', lease: '200ms' } },
      schema: { 'var.g.k': { type: 'string' } },
      documents: {},
      clockMs: () => clock,
      now: () => new Date(clock).toISOString(),
    });
    store.ingest('g', 'g', batch({ values: { 'g.k': 'v' } }));
    clock = 0; // wall clock jumped backwards after the observation
    expect(store.runtimeSnapshot('var.g.k')?.freshness).toBe('fresh');
    expect(store.status().g?.snapshotAge).toBeLessThanOrEqual(0);
  });

  it('PINNED: effectiveAt is carried verbatim and is NOT ordering-checked against the prior revision', () => {
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.k': { type: 'string' } },
      documents: {},
    });
    store.ingest('g', 'g', batch({ generation: 2, revision: 'sha256:new', effectiveAt: '2026-06-01T00:00:00Z', values: { 'g.k': 'new' } }));
    store.ingest('g', 'g', batch({ generation: 3, revision: 'sha256:older', effectiveAt: '2020-01-01T00:00:00Z', values: { 'g.k': 'older' } }));
    // The store does not compare effectiveAt: the later-arriving batch wins regardless.
    expect(store.runtimeSnapshot('var.g.k')?.effectiveAt).toBe('2020-01-01T00:00:00Z');
    expect(store.readRuntimeVar('var.g.k')).toBe('older');
  });
});

describe('generation numerics', () => {
  it('carries a generation at Number.MAX_SAFE_INTEGER without precision loss', () => {
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.k': { type: 'string' } },
      documents: {},
    });
    store.ingest('g', 'g', batch({ generation: Number.MAX_SAFE_INTEGER, values: { 'g.k': 'v' } }));
    expect(store.runtimeSnapshot('var.g.k')?.generation).toBe(Number.MAX_SAFE_INTEGER);
    expect(store.status().g?.appliedGeneration).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('DEFECT-PIN: int64 generations beyond MAX_SAFE_INTEGER lose precision at the Number() edge', () => {
    // The rpc loader pins `longs: String` and the provider converts with `Number(...)`.
    // Anything past 2^53-1 is silently rounded. Pinned so a future int64-safe carrier
    // (bigint or string passthrough) has a failing expectation to flip.
    const wire = '9007199254740993'; // MAX_SAFE_INTEGER + 2
    expect(Number(wire)).toBe(9_007_199_254_740_992);
    expect(String(Number(wire))).not.toBe(wire);
  });

  it('PINNED: out-of-order arrival is LAST-WRITE-WINS — an older generation overwrites a newer one', () => {
    // The design doc left this open ("highest revision wins else last-write-wins"). The
    // implementation performs NO generation comparison in LiveVarStore.ingest: whichever
    // batch arrives last is committed. Pinned as the contract; see the W5b report.
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.k': { type: 'string' } },
      documents: {},
    });
    store.ingest('g', 'g', batch({ generation: 9, revision: 'sha256:g9', values: { 'g.k': 'nine' } }));
    store.ingest('g', 'g', batch({ generation: 2, revision: 'sha256:g2', values: { 'g.k': 'two' } }));

    expect(store.readRuntimeVar('var.g.k')).toBe('two');
    expect(store.runtimeSnapshot('var.g.k')?.generation).toBe(2);
    expect(store.status().g?.appliedGeneration).toBe(2);
  });

  it('PINNED: a replayed IDENTICAL batch is idempotent and fires no watcher', () => {
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.k': { type: 'string' } },
      documents: {},
    });
    const fires: unknown[] = [];
    store.watch('var.g.k', (next) => fires.push(next.value));

    const replayed = batch({ generation: 5, revision: 'sha256:same', values: { 'g.k': 'v' } });
    expect(store.ingest('g', 'g', replayed).ok).toBe(true);
    expect(store.ingest('g', 'g', { ...replayed }).ok).toBe(true);
    expect(store.ingest('g', 'g', { ...replayed }).ok).toBe(true);

    // Watchers are gated on (revision, generation) changing — a replay is silent.
    expect(fires).toEqual(['v']);
    expect(store.readRuntimeVar('var.g.k')).toBe('v');
  });

  it('PINNED: same revision with a DIFFERENT generation re-fires watchers', () => {
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.k': { type: 'string' } },
      documents: {},
    });
    const fires: unknown[] = [];
    store.watch('var.g.k', (next) => fires.push(next.generation));

    store.ingest('g', 'g', batch({ generation: 1, revision: 'sha256:same', values: { 'g.k': 'v' } }));
    store.ingest('g', 'g', batch({ generation: 2, revision: 'sha256:same', values: { 'g.k': 'v' } }));
    expect(fires).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// B. Key / scope edges
// ---------------------------------------------------------------------------

describe('key and scope edge cases', () => {
  it('classifies scopes syntactically: no dot = group, any dot = key (incl. unicode and empty)', () => {
    expect(isVarGroupScope('agentic')).toBe(true);
    expect(isVarGroupScope('función')).toBe(true);
    expect(isVarGroupScope('日本語グループ')).toBe(true);
    expect(isVarGroupScope('')).toBe(true); // PINNED: the empty scope classifies as a GROUP
    expect(isVarKeyScope('agentic.lanes.vinci')).toBe(true);
    expect(isVarKeyScope('a.')).toBe(true); // PINNED: a trailing dot makes it a KEY scope
    expect(isVarGroupScope('a.')).toBe(false);
  });

  it('toCanonicalVarValues: group scope passes objects through, and coerces non-objects to {}', () => {
    expect(toCanonicalVarValues('g', { 'g.a': 1 })).toEqual({ 'g.a': 1 });
    expect(toCanonicalVarValues('g', null)).toEqual({});
    expect(toCanonicalVarValues('g', [1, 2, 3])).toEqual({});
    expect(toCanonicalVarValues('g', 'scalar')).toEqual({});
    expect(toCanonicalVarValues('g', undefined)).toEqual({});
  });

  it('toCanonicalVarValues: key scope wraps ANY document, including null and arrays', () => {
    expect(toCanonicalVarValues('g.k', { a: 1 })).toEqual({ 'g.k': { a: 1 } });
    expect(toCanonicalVarValues('g.k', null)).toEqual({ 'g.k': null });
    expect(toCanonicalVarValues('g.k', [1])).toEqual({ 'g.k': [1] });
  });

  it('toValueOverlayKey maps var.<group>.<rest> onto its static value.* twin', () => {
    expect(toValueOverlayKey('var.agentic.lanes.vinci')).toBe('value.agentic.lanes.vinci');
    expect(toValueOverlayKey('var.g')).toBe('value.g');
  });

  it('resolves a KEY-scoped activation through the longest-matching stored scope', () => {
    // W5a flagged the prefix rule as untested: a key-scoped commit stored under
    // `g.a.b` must satisfy reads of `var.g.a.b` while a group-scoped commit under `g`
    // satisfies every key beneath it. The longest stored prefix wins.
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.a.b': { type: 'string' }, 'var.g.c': { type: 'string' } },
      documents: {},
    });

    store.ingest('g', 'g', batch({ values: { 'g.a.b': 'from-group', 'g.c': 'group-only' } }));
    expect(store.readRuntimeVar('var.g.a.b')).toBe('from-group');

    // A narrower key-scoped commit shadows the group scope for that key only.
    store.ingest('g.a.b', 'g', batch({ generation: 2, revision: 'sha256:k', values: { 'g.a.b': 'from-key' } }));
    expect(store.readRuntimeVar('var.g.a.b')).toBe('from-key');
    expect(store.readRuntimeVar('var.g.c')).toBe('group-only');
    expect(store.hasRuntimeScope('g.a.b')).toBe(true);
    expect(store.hasRuntimeScope('g.zzz')).toBe(true); // still covered by the group scope
  });

  it('PINNED: a key whose name collides with a group name is resolved by the group scope', () => {
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.g': { type: 'string' } },
      documents: {},
    });
    store.ingest('g', 'g', batch({ values: { 'g.g': 'inner' } }));
    expect(store.readRuntimeVar('var.g.g')).toBe('inner');
  });

  it('handles unicode and dotted-looking group/key names end to end', () => {
    const store = new LiveVarStore({
      groups: { 'grüße': { source: 's', mode: 'prefetch' } },
      schema: { 'var.grüße.日本': { type: 'string' } },
      documents: {},
    });
    expect(store.ingest('grüße', 'grüße', batch({ values: { 'grüße.日本': 'ようこそ' } })).ok).toBe(true);
    expect(store.readRuntimeVar('var.grüße.日本')).toBe('ようこそ');
  });

  it('tolerates absurdly deep key nesting without stack or lookup failure', () => {
    const depth = 500;
    const rest = Array.from({ length: depth }, (_, index) => `s${index}`).join('.');
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { [`var.g.${rest}`]: { type: 'string' } },
      documents: {},
    });
    expect(store.ingest('g', 'g', batch({ values: { [`g.${rest}`]: 'deep' } })).ok).toBe(true);
    expect(store.readRuntimeVar(`var.g.${rest}`)).toBe('deep');
  });

  it('SLOW-ISH: commits a multi-megabyte document without error (bounded under a second)', () => {
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.blob': { type: 'string' } },
      documents: {},
    });
    const blob = 'x'.repeat(4 * 1024 * 1024); // 4 MiB
    expect(store.ingest('g', 'g', batch({ values: { 'g.blob': blob } })).ok).toBe(true);
    expect((store.readRuntimeVar('var.g.blob') as string).length).toBe(blob.length);
    // Status must never inline the payload.
    expect(JSON.stringify(store.status()).length).toBeLessThan(2_000);
  });

  it('treats an absent/empty values map as a valid empty commit', () => {
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.k': { type: 'string' } },
      documents: {},
    });
    expect(store.ingest('g', 'g', { generation: 1, revision: 'r', effectiveAt: 't', values: {} }).ok).toBe(true);
    expect(store.readRuntimeVar('var.g.k')).toBeUndefined();
    // `values` missing entirely (a malformed provider) must not throw.
    expect(
      store.ingest('g', 'g', { generation: 2, revision: 'r2', effectiveAt: 't' } as unknown as VarSnapshotBatch).ok,
    ).toBe(true);
  });

  it('rejects a document whose value violates its bound document schema and keeps LKG', () => {
    const warn = vi.fn();
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.doc': { document: 'd/v1' } },
      documents: { 'd/v1': { fields: { on: { type: 'boolean', required: true } }, additionalProperties: false } },
      warn,
    });

    expect(store.ingest('g', 'g', batch({ values: { 'g.doc': { on: true } } })).ok).toBe(true);
    for (const bad of [null, [1], 'scalar', { on: true, extra: 1 }, {}]) {
      const result = store.ingest('g', 'g', batch({ generation: 2, revision: `sha256:${JSON.stringify(bad)}`, values: { 'g.doc': bad } }));
      expect(result.ok).toBe(false);
      expect(result.issues?.length).toBeGreaterThan(0);
    }
    expect(store.readRuntimeVar('var.g.doc')).toEqual({ on: true });
  });

  it('after close(), ingest is refused and watchers are dropped', () => {
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.k': { type: 'string' } },
      documents: {},
    });
    const fires: unknown[] = [];
    store.watch('var.g.k', () => fires.push(1));
    store.close();
    expect(store.ingest('g', 'g', batch({ values: { 'g.k': 'v' } })).ok).toBe(false);
    expect(fires).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B. Watcher lifecycle during a notify pass
// ---------------------------------------------------------------------------

describe('watcher lifecycle during a notify pass', () => {
  it('PINNED: unsubscribing a not-yet-visited watcher inside a callback suppresses its fire', () => {
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.k': { type: 'string' } },
      documents: {},
    });
    const seen: string[] = [];
    let stopSecond = (): void => undefined;
    store.watch('var.g.k', () => {
      seen.push('first');
      stopSecond();
    });
    stopSecond = store.watch('var.g.k', () => seen.push('second'));

    store.ingest('g', 'g', batch({ values: { 'g.k': 'v' } }));
    expect(seen).toEqual(['first']);
  });

  it('DEFECT-PIN: a watcher REGISTERED inside a callback fires for the commit that preceded it', () => {
    // Watchers live in a Set iterated with for-of during notify, so an entry added mid-pass is
    // visited in that same pass and — having no `previous` entry — fires for a commit that
    // happened before it subscribed. Arguably a spurious fire; pinned, see the W5b report.
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.k': { type: 'string' } },
      documents: {},
    });
    const seen: string[] = [];
    store.watch('var.g.k', () => {
      seen.push('first');
      if (seen.length === 1) {
        store.watch('var.g.k', () => seen.push('late'));
      }
    });

    store.ingest('g', 'g', batch({ values: { 'g.k': 'v' } }));
    expect(seen).toEqual(['first', 'late']);
  });

  it('a prefix watcher fires per matching schema key and ignores non-matching ones', () => {
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.a': { type: 'string' }, 'var.g.b': { type: 'string' }, 'var.other.c': { type: 'string' } },
      documents: {},
    });
    const seen: string[] = [];
    store.watch('var.g.*', (next: ResolvedVarSnapshot) => seen.push(String(next.value)));
    store.ingest('g', 'g', batch({ values: { 'g.a': 'A', 'g.b': 'B' } }));
    expect(seen.sort()).toEqual(['A', 'B']);
  });
});

// ---------------------------------------------------------------------------
// B. VarManager — subscriptions, ondemand dedupe, lifecycle
// ---------------------------------------------------------------------------

function managerOptions(
  provider: VarSourceProvider,
  overrides: Partial<ConstructorParameters<typeof VarManager>[0]> = {},
): ConstructorParameters<typeof VarManager>[0] {
  const source: NormalizedVarSourceDefinition = { transport: 'http', url: 'http://unused.local', auth: {} };
  return {
    varSources: { svc: source },
    vars: { g: { source: 'svc', mode: 'prefetch' } },
    documents: {},
    schema: { 'var.g.k': { type: 'string' } },
    providerModules: [{ transport: 'http', create: () => provider }],
    resolveSecret: async () => 'secret-material',
    warn: () => undefined,
    ...overrides,
  };
}

describe('VarManager.startSubscriptions', () => {
  it('subscribes prefetch groups to a subscribe-capable provider and ingests pushed batches', async () => {
    let pushed: ((b: VarSnapshotBatch) => void) | undefined;
    let subscribedScopes: unknown;
    let stopped = 0;

    const provider: VarSourceProvider = {
      async pull() {
        return batch({ values: { 'g.k': 'pulled' } });
      },
      subscribe(scopes, onBatch) {
        subscribedScopes = scopes;
        pushed = onBatch;
        return () => {
          stopped += 1;
        };
      },
      async close() {
        /* noop */
      },
    };

    const manager = new VarManager(managerOptions(provider));
    manager.startSubscriptions();

    expect(subscribedScopes).toEqual([{ group: 'g' }]);
    expect(pushed).toBeTypeOf('function');

    pushed?.(batch({ generation: 7, revision: 'sha256:push', values: { 'g.k': 'pushed' } }));
    expect(manager.readRuntimeVar('var.g.k')).toBe('pushed');
    expect(manager.status().g?.appliedGeneration).toBe(7);

    await manager.close();
    expect(stopped).toBe(1);
    // PINNED: after close, a late push from a laggy provider is dropped, and the last
    // committed snapshot is retained (close does not clear already-committed scopes).
    pushed?.(batch({ generation: 8, revision: 'sha256:late', values: { 'g.k': 'late' } }));
    expect(manager.readRuntimeVar('var.g.k')).toBe('pushed');
    expect(manager.status().g?.appliedGeneration).toBe(7);
  });

  it('skips ondemand groups and providers with no subscribe capability', () => {
    let subscribeCalls = 0;
    const provider: VarSourceProvider = {
      async pull() {
        return batch({ values: {} });
      },
      subscribe() {
        subscribeCalls += 1;
        return () => undefined;
      },
      async close() {
        /* noop */
      },
    };

    const manager = new VarManager(
      managerOptions(provider, { vars: { g: { source: 'svc', mode: 'ondemand' } } }),
    );
    manager.startSubscriptions();
    expect(subscribeCalls).toBe(0);

    const pullOnly: VarSourceProvider = {
      async pull() {
        return batch({ values: {} });
      },
      async close() {
        /* noop */
      },
    };
    const manager2 = new VarManager(managerOptions(pullOnly));
    expect(() => manager2.startSubscriptions()).not.toThrow();
  });

  it('does not throw when the transport module is missing entirely', () => {
    const manager = new VarManager({
      ...managerOptions({ async pull() { return batch({ values: {} }); }, async close() { /* noop */ } }),
      providerModules: [],
    });
    expect(() => manager.startSubscriptions()).not.toThrow();
  });

  it('PINNED: a pushed batch with an empty values map is dropped (no group can be derived)', () => {
    let pushed: ((b: VarSnapshotBatch) => void) | undefined;
    const provider: VarSourceProvider = {
      async pull() {
        return batch({ values: {} });
      },
      subscribe(_scopes, onBatch) {
        pushed = onBatch;
        return () => undefined;
      },
      async close() {
        /* noop */
      },
    };
    const manager = new VarManager(managerOptions(provider));
    manager.startSubscriptions();
    expect(() => pushed?.(batch({ values: {} }))).not.toThrow();
    expect(manager.status()).toEqual({});
  });
});

describe('VarManager ondemand + refresh', () => {
  it('dedupes concurrent ondemand reads of the same group into ONE in-flight fetch', async () => {
    let pulls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const provider: VarSourceProvider = {
      async pull() {
        pulls += 1;
        await gate;
        return batch({ values: { 'g.k': 'fetched' } });
      },
      async close() {
        /* noop */
      },
    };

    const manager = new VarManager(managerOptions(provider, { vars: { g: { source: 'svc', mode: 'ondemand' } } }));

    // Ten sibling reads while the first fetch is still in flight.
    for (let i = 0; i < 10; i += 1) {
      expect(manager.readRuntimeVar('var.g.k')).toBeUndefined();
    }
    expect(pulls).toBe(1);

    release();
    await vi.waitFor(() => expect(manager.readRuntimeVar('var.g.k')).toBe('fetched'));
    expect(pulls).toBe(1);
    await manager.close();
  });

  it('refreshVar is a no-op while the snapshot is fresh and refetches once it is not', async () => {
    let clock = 0;
    let pulls = 0;
    const provider: VarSourceProvider = {
      async pull() {
        pulls += 1;
        return batch({ generation: pulls, revision: `sha256:r${pulls}`, values: { 'g.k': `v${pulls}` } });
      },
      async close() {
        /* noop */
      },
    };
    const manager = new VarManager(
      managerOptions(provider, {
        vars: { g: { source: 'svc', mode: 'prefetch', ttl: '100ms' } },
        clockMs: () => clock,
        now: () => new Date(clock).toISOString(),
      }),
    );

    await manager.prefetch();
    expect(pulls).toBe(1);
    await manager.refreshVar('var.g.k');
    expect(pulls).toBe(1); // still fresh
    clock = 200;
    await manager.refreshVar('var.g.k');
    expect(pulls).toBe(2);
    // The bare (prefix-less) form normalizes to the same key.
    clock = 400;
    await manager.refreshVar('g.k');
    expect(pulls).toBe(3);
    await manager.close();
  });

  it('a transport failure on an OPTIONAL prefetch group warns and still resolves ready()', async () => {
    const warn = vi.fn();
    const provider: VarSourceProvider = {
      async pull() {
        throw new Error('ECONNRESET mid-stream');
      },
      async close() {
        /* noop */
      },
    };
    const manager = new VarManager(managerOptions(provider, { warn }));
    await expect(manager.prefetch()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'));
    expect(manager.status().g?.lastError).toContain('ECONNRESET');
    await manager.close();
  });

  it('a transport failure on a REQUIRED, otherwise-unresolvable prefetch group rejects', async () => {
    const provider: VarSourceProvider = {
      async pull() {
        throw new Error('getaddrinfo ENOTFOUND vars.invalid');
      },
      async close() {
        /* noop */
      },
    };
    const manager = new VarManager(
      managerOptions(provider, { schema: { 'var.g.k': { type: 'string', required: true } } }),
    );
    manager.setOverlayReader(() => undefined);
    await expect(manager.prefetch()).rejects.toThrow(/ENOTFOUND/);
    await manager.close();
  });

  it('a REQUIRED group whose keys ARE resolvable from a static tier degrades instead of rejecting', async () => {
    const warn = vi.fn();
    const provider: VarSourceProvider = {
      async pull() {
        throw new Error('503 from upstream');
      },
      async close() {
        /* noop */
      },
    };
    const manager = new VarManager(
      managerOptions(provider, { schema: { 'var.g.k': { type: 'string', required: true } }, warn }),
    );
    manager.setOverlayReader(() => 'static-fallback');
    await expect(manager.prefetch()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('503 from upstream'));
    await manager.close();
  });

  it('a var-less manager starts no timers and closes cleanly', async () => {
    const manager = new VarManager(managerOptions(
      { async pull() { return batch({ values: {} }); }, async close() { /* noop */ } },
      { vars: {}, schema: {} },
    ));
    manager.startPollers();
    manager.startSubscriptions();
    await expect(manager.prefetch()).resolves.toBeUndefined();
    expect(manager.status()).toEqual({});
    await expect(manager.close()).resolves.toBeUndefined();
  });

  it('startPollers ignores non-http sources and non-positive intervals', () => {
    const provider: VarSourceProvider = {
      async pull() {
        return batch({ values: {} });
      },
      async close() {
        /* noop */
      },
    };
    for (const pollInterval of [undefined, '0s', '0ms']) {
      const manager = new VarManager(
        managerOptions(provider, {
          varSources: {
            svc: {
              transport: 'http',
              url: 'http://unused.local',
              auth: {},
              ...(pollInterval ? { pollInterval } : {}),
            },
          },
        }),
      );
      expect(() => manager.startPollers()).not.toThrow();
      void manager.close();
    }
  });
});

// ---------------------------------------------------------------------------
// C. Security regressions (Critical Rules 4/5)
// ---------------------------------------------------------------------------

const SECURITY_MANIFEST = [
  'version: 1',
  'project:',
  '  name: var-edge',
  'varSources:',
  '  svc: { transport: http, url: "http://unused.local", auth: { bearer: secret.ops.token }, verify: secret.ops.verify }',
  'vars:',
  '  flags: { source: svc, mode: prefetch, ttl: 1m }',
  'schema:',
  '  var.flags.mode: { type: string, default: safe }',
  '  var.flags.ref: { type: string }',
  '',
].join('\n');

const SECRET_LITERAL = 'SUPER-SECRET-MATERIAL-9f3a';

describe('var security regressions', () => {
  function inlineProvider(values: Record<string, unknown>): VarSourceProviderModule {
    return {
      transport: 'http',
      create() {
        return {
          async pull() {
            return batch({ values });
          },
          async close() {
            /* noop */
          },
        };
      },
    };
  }

  it('SEC: no secret material appears in varStatus(), the projection, or warnings', async () => {
    const root = await fixtureRoot(SECURITY_MANIFEST);
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((entry) => String(entry)).join(' '));
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((entry) => String(entry)).join(' '));
    });

    try {
      const runtime = await createCnos({
        root,
        plugins: [
          valueLoader([
            { key: 'secret.ops.token', value: SECRET_LITERAL },
            { key: 'secret.ops.verify', value: SECRET_LITERAL },
          ]),
        ],
        varSourceProviders: [inlineProvider({ 'flags.mode': 'live', 'flags.ref': 'secret.ops.token' })],
      });

      expect(runtime.read('var.flags.mode')).toBe('live');

      const status = JSON.stringify(runtime.varStatus?.() ?? {});
      const projection = JSON.stringify(runtime.toServerProjection());

      expect(status).not.toContain(SECRET_LITERAL);
      expect(projection).not.toContain(SECRET_LITERAL);
      expect(warnings.join('\n')).not.toContain(SECRET_LITERAL);

      // The projection keeps the REF, not the material.
      expect(projection).toContain('secret.ops.token');

      // A var document carrying a `secret.*` ref stays an opaque string — never resolved.
      expect(runtime.read('var.flags.ref')).toBe('secret.ops.token');

      await runtime.close?.();
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('SEC: var.* never reaches toPublicEnv or the browser projection', async () => {
    const root = await fixtureRoot(SECURITY_MANIFEST);
    const runtime = await createCnos({
      root,
      plugins: [valueLoader([{ key: 'secret.ops.token', value: SECRET_LITERAL }, { key: 'secret.ops.verify', value: SECRET_LITERAL }])],
      varSourceProviders: [inlineProvider({ 'flags.mode': 'live' })],
    });

    expect(runtime.read('var.flags.mode')).toBe('live');

    const publicEnv = runtime.toPublicEnv?.() ?? {};
    expect(Object.keys(publicEnv).join(',')).not.toMatch(/VAR|FLAGS_MODE/i);
    expect(JSON.stringify(publicEnv)).not.toContain('live');
    expect(JSON.stringify(publicEnv)).not.toContain(SECRET_LITERAL);

    // The browser/public surface is driven by `publicKeys`, which structurally cannot
    // contain a var.* key (there is no var-to-public promotion path).
    const publicKeys = runtime.toServerProjection().publicKeys;
    expect(publicKeys.filter((key) => key.startsWith('var.'))).toEqual([]);
    expect(JSON.stringify(publicKeys)).not.toContain(SECRET_LITERAL);

    await runtime.close?.();
  });

  it('SEC: a rejection warning names the revision but never the offending value', () => {
    const warn = vi.fn();
    const store = new LiveVarStore({
      groups: { g: { source: 's', mode: 'prefetch' } },
      schema: { 'var.g.k': { type: 'number' } },
      documents: {},
      warn,
    });
    store.ingest('g', 'g', batch({ values: { 'g.k': SECRET_LITERAL } }));
    const message = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(message).toContain('sha256:r1');
    // The message reports the type mismatch, not the value that failed.
    expect(message).not.toContain(SECRET_LITERAL);
    expect(JSON.stringify(store.status())).not.toContain(SECRET_LITERAL);
  });
});

// ---------------------------------------------------------------------------
// D. Regression sweep — pre-var behavior must be untouched
// ---------------------------------------------------------------------------

describe('regression: var-less projections and runtimes are byte-identical to pre-var output', () => {
  const VARLESS_MANIFEST = [
    'version: 1',
    'project:',
    '  name: plain',
    'schema:',
    '  value.server.port: { type: number, default: 8080 }',
    '',
  ].join('\n');

  /** The exact `ServerProjection` key set a var-less manifest produced before the var feature. */
  const PRE_VAR_PROJECTION_KEYS = [
    'configHash',
    'derived',
    'meta',
    'profile',
    'publicKeys',
    'resolvedAt',
    'runtimeNamespaces',
    'secretRefs',
    'values',
    'version',
    'workspace',
  ];

  it('toServerProjection on a var-less manifest emits NO new top-level keys', async () => {
    const root = await fixtureRoot(VARLESS_MANIFEST);
    const runtime = await createCnos({ root, plugins: [valueLoader([{ key: 'value.server.port', value: 3000 }])] });
    const projection = runtime.toServerProjection();

    const keys = Object.keys(projection).sort();
    // Every key present must be one the pre-var runtime already emitted; no var block leaks in.
    expect(keys.filter((key) => !PRE_VAR_PROJECTION_KEYS.includes(key))).toEqual([]);
    for (const varKey of ['varSources', 'vars', 'documents']) {
      expect(Object.prototype.hasOwnProperty.call(projection, varKey)).toBe(false);
    }

    // Round-trips through JSON with no undefined-valued var keys reappearing.
    const roundTripped = JSON.parse(JSON.stringify(projection)) as Record<string, unknown>;
    expect(Object.keys(roundTripped).sort()).toEqual(keys);

    await runtime.close?.();
  });

  it('a var-less runtime exposes an empty var status, no timers, and a no-op close()', async () => {
    const root = await fixtureRoot(VARLESS_MANIFEST);
    const runtime = await createCnos({ root, plugins: [valueLoader([{ key: 'value.server.port', value: 3000 }])] });

    expect(runtime.read('value.server.port')).toBe(3000);
    expect(runtime.varStatus?.()).toEqual({});
    expect(runtime.refreshVars).toBeTypeOf('function');
    await expect(runtime.refreshVars?.()).resolves.toBeUndefined();
    await expect(runtime.close?.()).resolves.toBeUndefined();
    // close() is idempotent — a second call must not throw either.
    await expect(runtime.close?.()).resolves.toBeUndefined();
  });

  it('regression: the schema env/arg override chain behaves identically with and without vars', async () => {
    const OVERRIDE_SCHEMA = [
      'schema:',
      '  value.server.port:',
      '    type: number',
      '    default: 8080',
      '    env: [APP_PORT]',
      '    arg: ["--port"]',
      '',
    ].join('\n');

    const varless = await fixtureRoot(['version: 1', 'project:', '  name: plain', OVERRIDE_SCHEMA].join('\n'));
    const withVars = await fixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: withvars',
        'varSources:',
        '  svc: { transport: http, url: "http://unused.local" }',
        'vars:',
        '  flags: { source: svc, mode: ondemand }',
        OVERRIDE_SCHEMA,
        '  var.flags.mode: { type: string, default: safe }',
        '',
      ].join('\n'),
    );

    async function probe(root: string, extras: { processEnv?: Record<string, string>; cliArgs?: string[] }) {
      const runtime = await createCnos({
        root,
        plugins: [],
        processEnv: { ...extras.processEnv },
        cliArgs: extras.cliArgs ?? [],
      });
      const value = runtime.read('value.server.port');
      await runtime.close?.();
      return value;
    }

    for (const extras of [
      {},
      { processEnv: { APP_PORT: '9090' } },
      { cliArgs: ['--port', '7070'] },
      // arg beats env by the default `arg, env, cnos` priority.
      { processEnv: { APP_PORT: '9090' }, cliArgs: ['--port=7070'] },
      // a value that cannot be coerced falls through to the next source.
      { processEnv: { APP_PORT: 'not-a-number' } },
    ]) {
      const plain = await probe(varless, extras);
      const vars = await probe(withVars, extras);
      expect(vars).toEqual(plain);
    }

    // Absolute values, so a silent "both broke identically" cannot pass.
    expect(await probe(withVars, {})).toBe(8080);
    expect(await probe(withVars, { processEnv: { APP_PORT: '9090' } })).toBe(9090);
    expect(await probe(withVars, { cliArgs: ['--port=7070'] })).toBe(7070);
    expect(await probe(withVars, { processEnv: { APP_PORT: 'nope' } })).toBe(8080);
  });

  it('regression: a --cnos-patch patch file still applies, and loses to env/arg, with vars present', async () => {
    const root = await fixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: withvars',
        'varSources:',
        '  svc: { transport: http, url: "http://unused.local" }',
        'vars:',
        '  flags: { source: svc, mode: ondemand }',
        'schema:',
        '  value.server.port:',
        '    type: number',
        '    default: 8080',
        '    env: [APP_PORT]',
        '  var.flags.mode: { type: string, default: safe }',
        '',
      ].join('\n'),
    );

    const patchPath = path.join(root, 'patch.properties');
    // Patch files are keyed by FULL logical CNOS keys.
    await writeFile(patchPath, 'value.server.port=5555\n');

    const patched = await createCnos({ root, plugins: [], processEnv: {}, cliArgs: ['--cnos-patch', patchPath] });
    expect(patched.read('value.server.port')).toBe(5555);
    // The var plane is untouched by the patch.
    expect(patched.read('var.flags.mode')).toBe('safe');
    await patched.close?.();

    // env still beats the patch file (patch participates as the `cnos` source).
    const overridden = await createCnos({
      root,
      plugins: [],
      processEnv: { APP_PORT: '9090' },
      cliArgs: ['--cnos-patch', patchPath],
    });
    expect(overridden.read('value.server.port')).toBe(9090);
    await overridden.close?.();
  });

  it('regression: an env override on the value.* twin feeds var overlay tier ② unchanged', async () => {
    const root = await fixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: overlay-override',
        'varSources:',
        '  svc: { transport: http, url: "http://unused.local" }',
        'vars:',
        '  flags: { source: svc, mode: ondemand }',
        'schema:',
        '  value.flags.mode: { type: string, default: from-schema, env: [FLAGS_MODE] }',
        '  var.flags.mode: { type: string, default: var-default }',
        '',
      ].join('\n'),
    );

    // No runtime revision → tier ② reads value.flags.mode THROUGH the override chain.
    const plain = await createCnos({ root, plugins: [], processEnv: {}, cliArgs: [] });
    expect(plain.read('var.flags.mode')).toBe('from-schema');
    await plain.close?.();

    const overridden = await createCnos({ root, plugins: [], processEnv: { FLAGS_MODE: 'from-env' }, cliArgs: [] });
    expect(overridden.read('value.flags.mode')).toBe('from-env');
    expect(overridden.read('var.flags.mode')).toBe('from-env');

    // ...and the runtime tier still outranks the override chain when a revision lands.
    (overridden as unknown as { __ingestVar: (s: string, scope: string, b: VarSnapshotBatch) => void }).__ingestVar(
      'svc',
      'flags',
      batch({ values: { 'flags.mode': 'from-runtime' } }),
    );
    expect(overridden.read('var.flags.mode')).toBe('from-runtime');
    // `value.*` reads are NEVER affected by the var overlay.
    expect(overridden.read('value.flags.mode')).toBe('from-env');
    await overridden.close?.();
  });

  it('schema defaults, derived values, and value.* reads are unaffected when vars ARE present', async () => {
    const root = await fixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: var-edge',
        'varSources:',
        '  svc: { transport: http, url: "http://unused.local" }',
        'vars:',
        '  flags: { source: svc, mode: ondemand }',
        'schema:',
        '  value.server.port: { type: number, default: 8080 }',
        '  var.flags.mode: { type: string, default: safe }',
        '',
      ].join('\n'),
    );
    const runtime = await createCnos({
      root,
      plugins: [
        valueLoader([
          { key: 'value.server.host', value: 'localhost' },
          { key: 'value.url', value: { $derive: 'http://${value.server.host}:${value.server.port}' } },
        ]),
      ],
    });

    // The static/derived planes behave exactly as in a var-less runtime.
    expect(runtime.read('value.server.port')).toBe(8080);
    expect(runtime.read('value.url')).toBe('http://localhost:8080');
    // The var overlay does not inject `value.flags.mode` into the value graph.
    expect(runtime.graph.entries.has('value.flags.mode')).toBe(false);
    expect(runtime.read('var.flags.mode')).toBe('safe');
    await runtime.close?.();
  });
});
