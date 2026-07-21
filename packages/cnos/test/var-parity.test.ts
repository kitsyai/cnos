import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  CnosVarClosedError,
  CnosVarNoHeadError,
  CnosVarNotModifiedError,
  CnosVarRequiredError,
  type ConfigSpecRule,
  type NormalizedManifest,
  type NormalizedVarSourceDefinition,
  type ResolvedVarSnapshot,
  type VarGroupDefinition,
  type VarPullOptions,
  type VarPushEvent,
  type VarScope,
  type VarSnapshotBatch,
  type VarSourceProviderModule,
} from '@kitsy/cnos-core';

import { createSingletonVarSupport, type SingletonVarSupport } from '../src/runtime/varSupport.js';

/**
 * SHARED SEMANTIC PARITY SUITE for `var.*`.
 *
 * Twin of `packages/go/var_parity_test.go`. Both read the SAME declarative scenario files under
 * `fixtures/var-parity/scenarios/` and drive their own SDK's public surface against an in-process
 * fake source. The wire is already pinned by `fixtures/var-cross-sdk/`; this pins the SEMANTICS —
 * lifecycle, overlay tiers, deactivation, ordering, watcher dispatch, freshness, status, close —
 * which is where every one of the 16 review findings lived.
 *
 * Assertions are on observable public results only (values, tier, freshness, start/refresh
 * outcome KIND, status fields, watcher fire sequences). Internals are never asserted; they
 * legitimately differ. See `fixtures/var-parity/README.md` for the format and the divergence
 * policy.
 */

const SPEC_DIR = path.resolve(fileURLToPath(import.meta.url), '../../../../fixtures/var-parity/scenarios');

// --- spec model -------------------------------------------------------------

interface SourceResponse {
  kind: 'head' | 'no-head' | 'not-modified' | 'error';
  generation?: number;
  revision?: string;
  schemaId?: string;
  effectiveAt?: string;
  values?: Record<string, unknown>;
  message?: string;
}

interface PushEventSpec {
  kind: 'batch' | 'no-head';
  generation?: number;
  revision?: string;
  schemaId?: string;
  effectiveAt?: string;
  values?: Record<string, unknown>;
}

interface Step {
  action: string;
  key?: string;
  id?: string;
  scope?: string;
  ms?: number;
  count?: number;
  timeoutMs?: number;
  source?: string;
  response?: SourceResponse;
  event?: PushEventSpec;
  then?: Step;
  note?: string;
  // expect payloads
  startOutcome?: string;
  startErrorKind?: string;
  startErrorHasCause?: boolean;
  refreshOutcome?: string;
  refreshErrorKind?: string;
  closeOutcome?: string;
  closeSettledWithinMs?: number;
  settled?: boolean;
  read?: Record<string, unknown>;
  status?: Record<string, unknown> | 'divergent';
  watch?: { id: string; fires: Array<Record<string, unknown>>; unordered?: boolean };
  observed?: Record<string, Step>;
  adr?: string;
}

interface Scenario {
  name: string;
  axis: string;
  why: string;
  slow?: boolean;
  projection: {
    values?: Record<string, unknown>;
    varSources?: Record<string, { transport: string; pollInterval?: string }>;
    vars?: Record<string, VarGroupDefinition>;
    documents?: Record<string, never>;
    schema?: Record<string, ConfigSpecRule>;
  };
  source?: Record<string, SourceResponse>;
  steps: Step[];
}

function loadScenarios(): Scenario[] {
  const files = readdirSync(SPEC_DIR).filter((name) => name.endsWith('.json')).sort();

  if (files.length === 0) {
    throw new Error(`No parity scenario files found in ${SPEC_DIR}.`);
  }

  return files.flatMap((file) => {
    const parsed = JSON.parse(readFileSync(path.join(SPEC_DIR, file), 'utf8')) as Scenario[];

    if (!Array.isArray(parsed)) {
      throw new Error(`${file} must contain an ARRAY of parity scenarios.`);
    }

    return parsed;
  });
}

/**
 * The spec's transport aliases. `fake` is the in-process parity source; `missing` names a
 * transport for which NO provider module is registered (the deployment-gap axis). Both map onto
 * transport names the manifest schema accepts and that ship no real provider in either SDK.
 */
const TRANSPORT_ALIAS: Record<string, 'ws' | 'sse'> = { fake: 'ws', missing: 'sse' };

// --- the fake source --------------------------------------------------------

class FakeSource {
  readonly responses = new Map<string, SourceResponse>();
  readonly pulls = new Map<string, number>();
  private readonly gates = new Map<string, { promise: Promise<void>; release: () => void }>();
  private readonly subscribers: Array<(event: VarPushEvent) => void> = [];

  constructor(initial: Record<string, SourceResponse>) {
    for (const [scope, response] of Object.entries(initial)) {
      this.responses.set(scope, response);
    }
  }

  pullCount(scope: string): number {
    return this.pulls.get(scope) ?? 0;
  }

  block(scope: string): void {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.set(scope, { promise, release });
  }

  release(scope: string): void {
    const gate = this.gates.get(scope);

    if (!gate) {
      throw new Error(`releasePull: scope "${scope}" is not blocked.`);
    }

    this.gates.delete(scope);
    gate.release();
  }

  push(scope: string, event: PushEventSpec): void {
    if (this.subscribers.length === 0) {
      throw new Error(
        `push to scope "${scope}": no subscription is open. Only PREFETCH groups are subscribed in both SDKs.`,
      );
    }

    const delivered: VarPushEvent =
      event.kind === 'no-head'
        ? { kind: 'no-head', scope }
        : {
            kind: 'batch',
            scope,
            batch: {
              generation: event.generation ?? 0,
              revision: event.revision ?? '',
              effectiveAt: event.effectiveAt ?? '',
              values: event.values ?? {},
              ...(event.schemaId !== undefined ? { schemaId: event.schemaId } : {}),
            },
          };

    for (const subscriber of [...this.subscribers]) {
      subscriber(delivered);
    }
  }

  module(): VarSourceProviderModule {
    const self = this;

    return {
      transport: 'ws',
      create() {
        return {
          async pull(scope: VarScope, knownRevision?: string, options?: VarPullOptions): Promise<VarSnapshotBatch> {
            const key = scope.group ?? scope.key ?? '';
            self.pulls.set(key, self.pullCount(key) + 1);

            const gate = self.gates.get(key);

            if (gate) {
              // Honor an abort (close() racing an in-flight startup): the SDK owns the signal and
              // fires it from close(), so a gated pull must reject promptly rather than hang until
              // releasePull. This is what lets the Node close() return without waiting the pull
              // out — the mixed abort/gate race the whole DECISION-4 scenario turns on.
              const signal = options?.signal;

              if (signal?.aborted) {
                throw new DOMException('The var pull was aborted.', 'AbortError');
              }

              await new Promise<void>((resolve, reject) => {
                let settled = false;
                const finish = (fn: () => void): void => {
                  if (!settled) {
                    settled = true;
                    fn();
                  }
                };

                void gate.promise.then(() => finish(resolve));

                if (signal) {
                  signal.addEventListener(
                    'abort',
                    () => finish(() => reject(new DOMException('The var pull was aborted.', 'AbortError'))),
                    { once: true },
                  );
                }
              });
            }

            const response = self.responses.get(key) ?? { kind: 'no-head' as const };

            if (response.kind === 'no-head') {
              throw new CnosVarNoHeadError(key);
            }

            if (response.kind === 'not-modified') {
              throw new CnosVarNotModifiedError(key, knownRevision ?? '');
            }

            if (response.kind === 'error') {
              throw new Error(response.message ?? 'fake transport failure');
            }

            return {
              generation: response.generation ?? 0,
              revision: response.revision ?? '',
              effectiveAt: response.effectiveAt ?? '',
              values: response.values ?? {},
              ...(response.schemaId !== undefined ? { schemaId: response.schemaId } : {}),
            };
          },
          subscribe(_scopes: VarScope[], onEvent: (event: VarPushEvent) => void): () => void {
            self.subscribers.push(onEvent);
            return () => {
              const index = self.subscribers.indexOf(onEvent);

              if (index >= 0) {
                self.subscribers.splice(index, 1);
              }
            };
          },
          async close(): Promise<void> {
            /* the fake owns no resources */
          },
        };
      },
    };
  }
}

// --- runner state -----------------------------------------------------------

type Outcome = { outcome: 'ok' | 'error'; kind?: string; error?: unknown };

interface Fire {
  source: string;
  value: unknown;
  freshness: string;
}

interface ReadResult {
  found: boolean;
  value: unknown;
  source: string;
  freshness: string;
}

interface CommonStatus {
  source: string;
  freshness: string;
  appliedGeneration: number;
  revision: boolean;
  desiredGeneration: boolean;
  lastError: boolean;
  lastRejected: boolean;
}

const divergenceLog: string[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map a thrown startup/refresh failure onto a cross-SDK error KIND. Messages are deliberately
 * NOT compared across SDKs; the kind is. `closed` has no dedicated error class in the Node SDK,
 * so it is recognized from the manager's own two closed-runtime messages.
 */
function errorKind(error: unknown): string {
  if (error instanceof CnosVarRequiredError) {
    return 'required';
  }

  if (error instanceof CnosVarClosedError) {
    return 'closed';
  }

  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('closed var runtime') || message.includes('closed while startup was in flight')) {
    return 'closed';
  }

  return 'other';
}

class NodeParityRunner {
  private readonly values: Record<string, unknown>;
  private readonly schema: Record<string, ConfigSpecRule>;
  private readonly support: SingletonVarSupport | undefined;
  private readonly source: FakeSource;
  private readonly watchers = new Map<string, { stop: () => void; fires: Fire[] }>();

  private startPromise: Promise<void> | undefined;
  private startOutcome: Outcome | undefined;
  private refreshPromise: Promise<void> | undefined;
  private refreshOutcome: Outcome | undefined;
  private closePromise: Promise<void> | undefined;
  private closeOutcome: Outcome | undefined;
  private lastRead: ReadResult | undefined;

  constructor(private readonly scenario: Scenario) {
    this.values = scenario.projection.values ?? {};
    this.schema = scenario.projection.schema ?? {};
    this.source = new FakeSource(scenario.source ?? {});

    const varSources: Record<string, NormalizedVarSourceDefinition> = {};

    for (const [name, definition] of Object.entries(scenario.projection.varSources ?? {})) {
      const transport = TRANSPORT_ALIAS[definition.transport];

      if (!transport) {
        throw new Error(`Unsupported spec transport "${definition.transport}" (use "fake" or "missing").`);
      }

      varSources[name] = {
        transport,
        url: 'parity://fake',
        auth: {},
        ...(definition.pollInterval !== undefined ? { pollInterval: definition.pollInterval } : {}),
      };
    }

    const vars = scenario.projection.vars ?? {};
    const enabled = Object.keys(varSources).length > 0 && Object.keys(vars).length > 0;

    this.support = enabled
      ? createSingletonVarSupport({
          varSources,
          vars,
          documents: {},
          schema: this.schema,
          manifest: { schema: this.schema } as unknown as NormalizedManifest,
          providerModules: [this.source.module()],
          resolveSecret: async () => 'parity-token',
          readStaticValue: (valueKey) => this.values[valueKey.slice('value.'.length)],
        })
      : undefined;
  }

  // --- SDK surface ----------------------------------------------------------

  /** Tier ②/③ only — the same fallback the product wiring computes. */
  private fallbackSnapshot(key: string): ResolvedVarSnapshot {
    const staticValue = this.values[key.slice('var.'.length)];

    if (staticValue !== undefined) {
      return { value: staticValue, source: 'static', freshness: 'fresh' };
    }

    return { value: this.schema[key]?.default, source: 'default', freshness: 'fresh' };
  }

  private read(key: string): ReadResult {
    const value = this.support ? this.support.readVar(key, false) : this.fallbackSnapshot(key).value;
    const snapshot = this.support ? this.support.varSnapshot(key) : this.fallbackSnapshot(key);

    return {
      found: value !== undefined,
      value,
      source: snapshot.source,
      freshness: snapshot.freshness,
    };
  }

  private status(key: string): CommonStatus {
    const stripped = key.slice('var.'.length);
    const entry = this.support?.manager.status()[stripped];

    if (!entry) {
      throw new Error(`varStatus() has no entry for "${stripped}".`);
    }

    return {
      source: entry.source,
      freshness: entry.freshness,
      appliedGeneration: entry.appliedGeneration,
      revision: entry.revision !== undefined,
      desiredGeneration: entry.desiredGeneration !== undefined,
      lastError: entry.lastError !== null && entry.lastError !== undefined,
      lastRejected: entry.lastRejected !== undefined,
    };
  }

  // --- interpreter ----------------------------------------------------------

  async run(): Promise<void> {
    try {
      for (const step of this.scenario.steps) {
        await this.step(step);
      }
    } finally {
      for (const watcher of this.watchers.values()) {
        watcher.stop();
      }

      // Release anything still gated so a failing scenario cannot wedge the suite.
      for (const scope of Object.keys(this.scenario.source ?? {})) {
        try {
          this.source.release(scope);
        } catch {
          /* not blocked */
        }
      }

      await this.startPromise?.catch(() => undefined);
      await this.refreshPromise?.catch(() => undefined);
      await this.closePromise?.catch(() => undefined);
      await this.support?.manager.close().catch(() => undefined);
    }
  }

  private async step(step: Step): Promise<void> {
    switch (step.action) {
      case 'start':
        await this.startAsync();
        await this.awaitStart();
        return;
      case 'startAsync':
        await this.startAsync();
        return;
      case 'awaitStart':
        await this.awaitStart();
        return;
      case 'close':
        this.closeAsync();
        await this.awaitClose();
        return;
      case 'closeAsync':
        this.closeAsync();
        return;
      case 'awaitClose':
        await this.awaitClose();
        return;
      case 'setSource':
        this.source.responses.set(this.requireScope(step), step.response ?? { kind: 'no-head' });
        return;
      case 'blockPull':
        this.source.block(this.requireScope(step));
        return;
      case 'releasePull':
        this.source.release(this.requireScope(step));
        return;
      case 'awaitPullIssued':
        await this.awaitPullIssued(this.requireScope(step), step.count ?? 1, step.timeoutMs ?? 3000);
        return;
      case 'push':
        this.source.push(this.requireScope(step), step.event ?? { kind: 'no-head' });
        return;
      case 'read':
        this.lastRead = this.read(this.requireKey(step));
        return;
      case 'awaitRead':
        await this.awaitRead(this.requireKey(step), step.source ?? 'runtime', step.timeoutMs ?? 3000);
        return;
      case 'refreshVars':
        this.refreshVarsAsync();
        await this.awaitRefresh();
        return;
      case 'refreshVarsAsync':
        this.refreshVarsAsync();
        return;
      case 'refreshVar':
        this.refreshVarAsync(this.requireKey(step));
        await this.awaitRefresh();
        return;
      case 'awaitRefresh':
        await this.awaitRefresh();
        return;
      case 'watch':
        this.watch(step);
        return;
      case 'unwatch': {
        const watcher = this.watchers.get(step.id ?? '');

        if (!watcher) {
          throw new Error(`unwatch: no watcher registered as "${step.id}".`);
        }

        watcher.stop();
        return;
      }
      case 'sleep':
        await delay(step.ms ?? 0);
        return;
      case 'expect':
        await this.expect(step);
        return;
      default:
        // A scenario the runner cannot express FAILS LOUDLY. Silent skips are how this feature
        // accumulated tests that asserted nothing.
        throw new Error(`UNSUPPORTED parity action "${step.action}" — extend BOTH runners or drop the scenario.`);
    }
  }

  private requireScope(step: Step): string {
    if (!step.scope) {
      throw new Error(`action "${step.action}" requires a "scope".`);
    }

    return step.scope;
  }

  private requireKey(step: Step): string {
    if (!step.key) {
      throw new Error(`action "${step.action}" requires a "key".`);
    }

    return step.key;
  }

  private async startAsync(): Promise<void> {
    this.startOutcome = undefined;
    this.startPromise = (this.support ? this.support.start() : Promise.resolve()).then(
      () => {
        this.startOutcome = { outcome: 'ok' };
      },
      (error: unknown) => {
        this.startOutcome = { outcome: 'error', kind: errorKind(error), error };
      },
    );
    // Let the attempt reach its first await so `awaitPullIssued` can observe the prefetch.
    await Promise.resolve();
  }

  private async awaitStart(): Promise<void> {
    if (!this.startPromise) {
      throw new Error('awaitStart: no start attempt is in flight.');
    }

    await this.startPromise;
  }

  private closeAsync(): void {
    this.closePromise = (this.support ? this.support.manager.close() : Promise.resolve()).then(
      () => {
        this.closeOutcome = { outcome: 'ok' };
      },
      (error: unknown) => {
        this.closeOutcome = { outcome: 'error', kind: errorKind(error) };
      },
    );
  }

  private async awaitClose(): Promise<void> {
    await this.closePromise;
  }

  private refreshVarsAsync(): void {
    this.refreshOutcome = undefined;
    this.refreshPromise = (this.support ? this.support.manager.refreshVars() : Promise.resolve()).then(
      () => {
        this.refreshOutcome = { outcome: 'ok' };
      },
      (error: unknown) => {
        this.refreshOutcome = { outcome: 'error', kind: errorKind(error) };
      },
    );
  }

  private refreshVarAsync(key: string): void {
    this.refreshOutcome = undefined;
    this.refreshPromise = (this.support ? this.support.manager.refreshVar(key) : Promise.resolve()).then(
      () => {
        this.refreshOutcome = { outcome: 'ok' };
      },
      (error: unknown) => {
        this.refreshOutcome = { outcome: 'error', kind: errorKind(error) };
      },
    );
  }

  private async awaitRefresh(): Promise<void> {
    if (!this.refreshPromise) {
      throw new Error('awaitRefresh: no refresh is in flight.');
    }

    await this.refreshPromise;
  }

  private watch(step: Step): void {
    const id = step.id ?? '';
    const key = this.requireKey(step);
    const record: { stop: () => void; fires: Fire[] } = { stop: () => undefined, fires: [] };
    let reentrantDone = false;

    const stop = this.support
      ? this.support.manager.watch(key, (next) => {
          record.fires.push({
            source: next.source,
            value: next.value,
            freshness: next.freshness,
          });

          if (step.then && !reentrantDone) {
            reentrantDone = true;
            void this.step(step.then);
          }
        })
      : () => undefined;

    record.stop = stop;
    this.watchers.set(id, record);
  }

  private async awaitPullIssued(scope: string, count: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.source.pullCount(scope) >= count) {
        return;
      }

      await delay(5);
    }

    throw new Error(
      `awaitPullIssued: scope "${scope}" saw ${this.source.pullCount(scope)} pulls, expected at least ${count}.`,
    );
  }

  private async awaitRead(key: string, source: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = this.read(key);
      this.lastRead = result;

      if (result.source === source) {
        return;
      }

      await delay(5);
    }

    throw new Error(`awaitRead: "${key}" never reached source "${source}" (last: ${this.lastRead?.source}).`);
  }

  // --- assertions -----------------------------------------------------------

  private async expect(step: Step): Promise<void> {
    if (step.status === 'divergent') {
      const observed = step.observed?.node;

      if (!observed) {
        throw new Error(`divergent expectation in "${this.scenario.name}" has no observed.node block.`);
      }

      divergenceLog.push(`${this.scenario.name}: ${step.note ?? 'known divergence'}`);
      // The divergence is REPORTED, not tolerated: the Node side must still match exactly what
      // the spec records for it. If it drifts again, this fails.
      await this.assertAll(observed);
      return;
    }

    await this.assertAll(step);
  }

  private async assertAll(step: Step): Promise<void> {
    if (step.startOutcome !== undefined) {
      expect(this.startOutcome?.outcome, 'startOutcome').toBe(step.startOutcome);
    }

    if (step.startErrorKind !== undefined) {
      expect(this.startOutcome?.kind, 'startErrorKind').toBe(step.startErrorKind);
    }

    if (step.startErrorHasCause !== undefined) {
      // DECISION 1: the required/unavailable startup error preserves the underlying
      // transport/authentication failure as its standard `cause`.
      const hasCause = (this.startOutcome?.error as { cause?: unknown } | undefined)?.cause !== undefined;
      expect(hasCause, 'startErrorHasCause').toBe(step.startErrorHasCause);
    }

    if (step.refreshOutcome !== undefined) {
      expect(this.refreshOutcome?.outcome, 'refreshOutcome').toBe(step.refreshOutcome);
    }

    if (step.refreshErrorKind !== undefined) {
      expect(this.refreshOutcome?.kind, 'refreshErrorKind').toBe(step.refreshErrorKind);
    }

    if (step.closeOutcome !== undefined) {
      expect(this.closeOutcome?.outcome, 'closeOutcome').toBe(step.closeOutcome);
    }

    if (step.closeSettledWithinMs !== undefined) {
      const settled = await this.closeSettledWithin(step.closeSettledWithinMs);
      expect(settled, 'closeSettledWithin').toBe(step.settled ?? true);
    }

    if (step.read !== undefined) {
      const actual = this.lastRead;

      if (!actual) {
        throw new Error('a `read` expectation needs a preceding `read`/`awaitRead` step.');
      }

      for (const [field, want] of Object.entries(step.read)) {
        expect(actual[field as keyof ReadResult], `read.${field}`).toEqual(want);
      }
    }

    if (step.status !== undefined && step.status !== 'divergent') {
      const wanted = step.status as Record<string, unknown>;
      const key = String(wanted['key'] ?? '');

      if (!key) {
        throw new Error('a `status` expectation needs a "key".');
      }

      const actual = this.status(key);

      for (const [field, want] of Object.entries(wanted)) {
        if (field === 'key') {
          continue;
        }

        expect(actual[field as keyof CommonStatus], `status.${field}`).toEqual(want);
      }
    }

    if (step.watch !== undefined) {
      const watcher = this.watchers.get(step.watch.id);

      if (!watcher) {
        throw new Error(`a \`watch\` expectation names an unregistered watcher "${step.watch.id}".`);
      }

      const actual = watcher.fires.map((fire) => ({ source: fire.source, value: fire.value }));
      const wanted = step.watch.fires.map((fire) => ({ source: fire['source'], value: fire['value'] }));

      if (step.watch.unordered) {
        const sort = (entries: unknown[]): string[] => entries.map((entry) => JSON.stringify(entry)).sort();
        expect(sort(actual), `watch(${step.watch.id}).fires`).toEqual(sort(wanted));
      } else {
        expect(actual, `watch(${step.watch.id}).fires`).toEqual(wanted);
      }
    }
  }

  private async closeSettledWithin(ms: number): Promise<boolean> {
    if (!this.closePromise) {
      throw new Error('closeSettledWithin: no close() is in flight.');
    }

    const sentinel = Symbol('pending');
    const result = await Promise.race([
      this.closePromise.then(() => 'settled' as const).catch(() => 'settled' as const),
      delay(ms).then(() => sentinel),
    ]);

    return result !== sentinel;
  }
}

// --- suite ------------------------------------------------------------------

const scenarios = loadScenarios();

afterAll(() => {
  if (divergenceLog.length > 0) {
    console.log(
      `\n[var-parity] ${divergenceLog.length} KNOWN Node/Go divergence(s) exercised (recorded in the spec, not failures):\n` +
        divergenceLog.map((entry) => `  - ${entry}`).join('\n') +
        '\n',
    );
  }
});

describe('var.* cross-SDK semantic parity (shared spec)', () => {
  it('the shared spec is well formed and every scenario name is unique', () => {
    const seen = new Set<string>();

    for (const scenario of scenarios) {
      expect(scenario.name, 'scenario.name').toBeTruthy();
      expect(scenario.why, `${scenario.name}.why`).toBeTruthy();
      expect(scenario.axis, `${scenario.name}.axis`).toBeTruthy();
      expect(scenario.steps.length, `${scenario.name}.steps`).toBeGreaterThan(0);
      expect(seen.has(scenario.name), `duplicate scenario "${scenario.name}"`).toBe(false);
      seen.add(scenario.name);
    }

    expect(scenarios.length).toBeGreaterThan(20);
  });

  for (const scenario of scenarios) {
    it(`[${scenario.axis}] ${scenario.name}`, async () => {
      await new NodeParityRunner(scenario).run();
    }, 20_000);
  }
});
