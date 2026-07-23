import {
  CnosVarClosedError,
  CnosVarNoHeadError,
  CnosVarNotModifiedError,
  CnosVarRequiredError,
} from '../errors.js';
import type { ConfigSpecRule } from '../types/spec.js';
import type {
  DocumentSchemaDefinition,
  NormalizedVarSourceDefinition,
  ResolvedVarSnapshot,
  VarGroupDefinition,
  VarPushEvent,
  VarScope,
  VarSnapshotBatch,
  VarSourceProvider,
  VarSourceProviderModule,
  VarStatusReport,
  VarWatchCallback,
} from '../types/var.js';
import { parseDuration } from '../utils/duration.js';
import { LiveVarStore, type IngestResult } from './varStore.js';
import { VAR_NAMESPACE_PREFIX } from './readVar.js';

export interface VarManagerOptions {
  varSources: Record<string, NormalizedVarSourceDefinition>;
  vars: Record<string, VarGroupDefinition>;
  documents: Record<string, DocumentSchemaDefinition>;
  schema: Record<string, ConfigSpecRule>;
  providerModules: VarSourceProviderModule[];
  resolveSecret: (ref: string) => Promise<string>;
  clockMs?: () => number;
  now?: () => string;
  warn?: (message: string) => void;
}

const DEFAULT_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

/** No transport module is registered for a source. Non-fatal: the overlay serves static/default. */
class ProviderUnavailableError extends Error {}

/**
 * Orchestrator-owned coordinator for `var.*`: constructs transport providers from the manifest,
 * drives prefetch/ondemand lifecycle, pollers, refresh, and the receiver ingest path — all
 * converging on {@link LiveVarStore}. CNOS surfaces freshness state; it never enforces policy.
 */
export class VarManager {
  readonly store: LiveVarStore;

  private readonly varSources: Record<string, NormalizedVarSourceDefinition>;
  private readonly vars: Record<string, VarGroupDefinition>;
  private readonly schema: Record<string, ConfigSpecRule>;
  private readonly providerModules: VarSourceProviderModule[];
  private readonly resolveSecret: (ref: string) => Promise<string>;
  private readonly warn: (message: string) => void;
  private readonly providers = new Map<string, VarSourceProvider>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly subscriptions = new Set<() => void>();
  private overlayReader?: (key: string) => unknown;
  private closed = false;
  /**
   * The in-flight {@link start} attempt. `close()` waits on it so an attempt that is still
   * awaiting prefetch cannot create providers/pollers/subscriptions AFTER close() has already
   * walked the sets it cleans — which leaked every one of them.
   */
  private startAttempt: Promise<void> | undefined;
  /**
   * The {@link AbortController} for the in-flight startup attempt. `close()` aborts it FIRST, so
   * the prefetch pull's network wait is cancelled promptly rather than blocking `close()` until
   * the transport's own timeout. The startup attempt then observes the closed runtime and rejects
   * with {@link CnosVarClosedError}. Mirrors Go's ctx-derived prefetch cancellation.
   */
  private startAbort: AbortController | undefined;

  constructor(options: VarManagerOptions) {
    this.varSources = options.varSources;
    this.vars = options.vars;
    this.schema = options.schema;
    this.providerModules = options.providerModules;
    this.resolveSecret = options.resolveSecret;
    this.warn = options.warn ?? ((message: string) => console.warn(message));
    this.store = new LiveVarStore({
      groups: options.vars,
      schema: options.schema,
      documents: options.documents,
      ...(options.clockMs ? { clockMs: options.clockMs } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.warn ? { warn: options.warn } : {}),
    });
  }

  /** Wire the full-overlay reader (runtime -> static -> default) used to check required resolvability. */
  setOverlayReader(reader: (key: string) => unknown): void {
    this.overlayReader = reader;
  }

  /**
   * Wire the static/default tier snapshot reader. The store needs it to report what a key falls
   * back to once its runtime head is removed — see {@link LiveVarStore.removeScope}.
   */
  setFallbackSnapshotReader(reader: (key: string) => ResolvedVarSnapshot | undefined): void {
    this.store.setFallbackSnapshotReader(reader);
  }

  // ---- Read path ---------------------------------------------------------

  readRuntimeVar(key: string): unknown {
    const value = this.store.readRuntimeVar(key);

    if (value === undefined) {
      this.maybeTriggerOndemand(key);
    }

    return value;
  }

  snapshot(key: string): ResolvedVarSnapshot | undefined {
    const snap = this.store.runtimeSnapshot(key);

    if (!snap) {
      this.maybeTriggerOndemand(key);
    }

    return snap;
  }

  status(): VarStatusReport {
    return this.store.status();
  }

  watch(keyOrPrefix: string, callback: VarWatchCallback): () => void {
    return this.store.watch(keyOrPrefix, callback);
  }

  private groupFor(key: string): string {
    return key.slice(VAR_NAMESPACE_PREFIX.length).split('.')[0] ?? '';
  }

  private maybeTriggerOndemand(key: string): void {
    if (this.closed) {
      return;
    }

    const path = key.slice(VAR_NAMESPACE_PREFIX.length);
    const group = this.groupFor(key);
    const definition = this.vars[group];

    if (!definition || definition.mode !== 'ondemand') {
      return;
    }

    // Ondemand fetches the whole group (one deduped fetch per group), never a bare key —
    // this keeps scalar extraction consistent with prefetch and dedupes sibling reads.
    if (this.store.hasRuntimeScope(path) || this.inFlight.has(group)) {
      return;
    }

    const promise = this.fetchScope(definition.source, group, { group }, group)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight.delete(group);
      });

    this.inFlight.set(group, promise);
  }

  // ---- Provider construction --------------------------------------------

  private provider(sourceId: string): VarSourceProvider {
    if (this.closed) {
      throw new Error(`[cnos:var] cannot construct a provider for source "${sourceId}": the var runtime is closed.`);
    }

    const cached = this.providers.get(sourceId);

    if (cached) {
      return cached;
    }

    const def = this.varSources[sourceId];

    if (!def) {
      throw new Error(`Unknown var source "${sourceId}".`);
    }

    const module = this.providerModules.find((candidate) => candidate.transport === def.transport);

    if (!module) {
      throw new ProviderUnavailableError(
        `No var source provider registered for transport "${def.transport}" (source "${sourceId}"). ` +
          `Register one via the varSourceProviders option or a batteries-included package.`,
      );
    }

    const provider = module.create(def, {
      resolveSecret: (ref) => this.resolveSecret(ref),
      onSubscriptionError: (error, info) => this.recordSubscriptionFailure(sourceId, error, info),
      onSubscriptionConnected: (scopes, info) => this.resyncSubscribedScopes(sourceId, scopes, info.reconnect),
    });
    this.providers.set(sourceId, provider);
    return provider;
  }

  /**
   * Converge every subscribed scope on a (re)connected stream — the SDK half of the ADR's
   * "on reconnect, re-pull subscribed scopes with known revisions to converge".
   *
   * The server only ever forwards FUTURE commits, so a mutation that landed while the stream
   * was down is lost without this. That is unrecoverable for an rpc source (it runs no poller),
   * and since a deactivation is a real state change a missed one means serving withdrawn policy
   * forever. The pull is issued AFTER the subscription is open (the provider calls this from
   * its connect path), so a commit racing the pull arrives on the stream instead of vanishing —
   * and the store's scope epoch decides which of the two wins.
   *
   * On the FIRST connect the scope is skipped only when the caller already prefetched a head
   * for it; when in doubt, pull — a redundant pull is far cheaper than a lost deactivation.
   */
  private resyncSubscribedScopes(sourceId: string, scopes: string[], reconnect: boolean): void {
    if (this.closed) {
      return;
    }

    for (const scopeString of scopes) {
      if (!reconnect && this.appliedRevision(scopeString) !== undefined) {
        continue;
      }

      const group = scopeString.split('.')[0] ?? scopeString;
      const scope: VarScope = scopeString.includes('.') ? { key: scopeString } : { group: scopeString };

      // Routed through the NORMAL pull path: ingest, `not-modified`, and `no-head` → scope
      // removal all behave exactly as they do for a poller. A failure is not fatal — the
      // stream is live and the next commit converges.
      // Defensive reconnect pulls clean up only the exact queried head. The canonical stream may
      // concurrently reconstruct active child scopes, which a cascading pull must never erase.
      void this.fetchScope(sourceId, group, scope, scopeString, undefined, true).catch(() => undefined);
    }
  }

  /**
   * A background subscription failure reported by a transport provider. It never propagates as
   * an exception (a stream error must not crash the host process); it lands in `varStatus()`
   * as the scope's `subscription` state so a consumer can alert on `failed`.
   */
  private recordSubscriptionFailure(
    sourceId: string,
    error: Error,
    info: { terminal: boolean; scopes: string[] },
  ): void {
    const scopes = info.scopes.length > 0 ? info.scopes : this.groupsForSource(sourceId);

    for (const scope of scopes) {
      const group = scope.split('.')[0] ?? scope;
      this.store.recordSubscription(scope, group, info.terminal ? 'failed' : 'retrying', error);
    }

    this.warn(
      `[cnos:var] subscription for source "${sourceId}" ${info.terminal ? 'FAILED (terminal, no further reconnects)' : 'dropped (retrying)'}: ${error.message}`,
    );
  }

  private groupsForSource(sourceId: string): string[] {
    return Object.entries(this.vars)
      .filter(([, definition]) => definition.source === sourceId)
      .map(([group]) => group);
  }

  // ---- Fetch / ingest ----------------------------------------------------

  private async fetchScope(
    sourceId: string,
    group: string,
    scope: VarScope,
    scopeString: string,
    signal?: AbortSignal,
    exactNoHead = false,
  ): Promise<'ingested' | 'rejected' | 'no-head' | 'not-modified' | 'superseded'> {
    const provider = this.provider(sourceId);
    const knownRevision = this.appliedRevision(scopeString);
    // MIXED PULL/PUSH ORDERING (canonical, both SDKs). A push always applies; a pull applies
    // only if no authoritative event landed for this scope while it was in flight. Without the
    // gate a slow pull could reintroduce a head the authority already deactivated, or a delayed
    // `no-head` could wipe a newer pushed activation — permanently, for an rpc source with no
    // poller. Everything after the `await` is synchronous, so the check and the apply are
    // atomic in the Node runtime.
    const epoch = this.store.scopeEpoch(scopeString);

    try {
      const batch = await provider.pull(scope, knownRevision, signal ? { signal } : undefined);

      if (this.closed || this.store.scopeEpoch(scopeString) !== epoch) {
        return 'superseded';
      }

      const result = this.store.ingest(scopeString, group, batch);
      this.store.recordRefresh(scopeString, group, batch.generation);
      return result.ok ? 'ingested' : 'rejected';
    } catch (error) {
      if (error instanceof CnosVarNotModifiedError) {
        this.store.recordRefresh(scopeString, group);
        return 'not-modified';
      }

      if (error instanceof CnosVarNoHeadError) {
        if (this.closed || this.store.scopeEpoch(scopeString) !== epoch) {
          return 'superseded';
        }

        // A DEFINITIVE answer from the authority: this scope has no active head. Clear the
        // runtime tier so the overlay restores ② static / ③ default without a redeploy
        // (acceptance #15). Contrast with the transport failure below, which is NOT an answer
        // and must retain last-known-good.
        this.applyNoHead(scopeString, group, !exactNoHead);
        this.store.recordRefresh(scopeString, group);
        return 'no-head';
      }

      // An aborted pull is NOT a transport failure — it is `close()` cancelling an in-flight
      // startup. Surface it as the closed-kind typed error so the startup caller learns the
      // runtime was closed (never a spurious "transport down"), and so it is not recorded as a
      // scope error. Mirrors Go, where the cancelled fetch ctx makes `StartVars` return
      // `ErrVarClosed`.
      if (signal?.aborted || this.closed) {
        throw new CnosVarClosedError(scopeString);
      }

      this.store.recordError(scopeString, group, error);
      throw error;
    }
  }

  /**
   * Apply a `no-head` outcome: atomically drop the scope's runtime tier so reads fall through
   * the overlay. Idempotent — a `no-head` for a scope that has nothing applied is a silent
   * no-op that wakes no watcher. Shared by the pull path and the push (`no_head`) path, in
   * every transport, so a deactivation converges the same way regardless of how it arrived.
   */
  private applyNoHead(scopeString: string, group: string, cascade = true): void {
    if (this.store.removeScope(scopeString, group, cascade)) {
      this.warn(
        `[cnos:var] scope "${scopeString}" has no active runtime head (deactivated); ` +
          'cleared the runtime tier and restored the static/default tiers.',
      );
    }
  }

  private appliedRevision(scopeString: string): string | undefined {
    return this.store.appliedRevision(scopeString);
  }

  /**
   * Receiver / push path: route an inbound batch through the SAME validated ingest.
   * Returns the {@link IngestResult} so a receiver can map a validation-rejected batch
   * to a 422 response; a successful ingest also records the refresh/desired generation.
   */
  ingest(_sourceId: string, scope: string, batch: VarSnapshotBatch): IngestResult {
    const group = scope.split('.')[0] ?? scope;
    const result = this.store.ingest(scope, group, batch);

    if (result.ok) {
      this.store.recordRefresh(scope, group, batch.generation);
    }

    return result;
  }

  /** Receiver / push deactivation path. A no-head is authoritative and removes nested scopes. */
  ingestNoHead(_sourceId: string, scope: string): void {
    const group = scope.split('.')[0] ?? scope;
    this.applyNoHead(scope, group);
    this.store.recordRefresh(scope, group);
  }

  // ---- Lifecycle ---------------------------------------------------------

  private prefetchGroups(): string[] {
    return Object.entries(this.vars)
      .filter(([, definition]) => definition.mode === 'prefetch')
      .map(([group]) => group);
  }

  private groupIsRequired(group: string): boolean {
    const prefix = `${VAR_NAMESPACE_PREFIX}${group}.`;
    return Object.entries(this.schema)
      .some(([key, rule]) => key.startsWith(prefix) && rule.required === true);
  }

  private requiredKeys(group: string): string[] {
    const prefix = `${VAR_NAMESPACE_PREFIX}${group}.`;
    return Object.entries(this.schema)
      .filter(([key, rule]) => key.startsWith(prefix) && rule.required === true)
      .map(([key]) => key);
  }

  /** Fetch all prefetch groups (parallel). Required-group failure rejects; optional warns + falls back. */
  async prefetch(signal?: AbortSignal): Promise<void> {
    await Promise.all(this.prefetchGroups().map((group) => this.prefetchGroup(group, signal)));
  }

  private async prefetchGroup(group: string, signal?: AbortSignal): Promise<void> {
    const definition = this.vars[group];

    if (!definition) {
      return;
    }

    const required = this.groupIsRequired(group);
    let failure: unknown;

    try {
      await this.fetchScope(definition.source, group, { group }, group, signal);
    } catch (error) {
      // `close()` cancelled this startup mid-prefetch. Closed beats every other classification —
      // the attempt is being torn down, so propagate it as-is (never re-map it to a required or
      // transport failure) and let `runStart` roll back and reject with the closed error.
      if (error instanceof CnosVarClosedError) {
        throw error;
      }

      // A missing transport module is a deployment gap: warned, and non-fatal ONLY while every
      // required key of the group still resolves through the static/default tiers. Returning
      // here skipped the required check below, so Node reported a ready runtime where Go
      // rejected `StartVars` — the carve-out was never meant to waive required enforcement.
      if (error instanceof ProviderUnavailableError) {
        this.warn(
          `[cnos:var] prefetch group "${group}": ${error.message} Serving static/default tiers.`,
        );
      } else {
        failure = error;
      }
    }

    // The required check runs after EVERY outcome, not only the thrown ones. `fetchScope`
    // returns `no-head` / `rejected` WITHOUT throwing, and both leave a required key with no
    // runtime value — a prefetch mandatory key that resolves from no tier must fail ready(),
    // exactly as the Go SDK does (`ErrVarRequired`). Checking only the catch path is what let
    // Node report a ready runtime while Go correctly refused to start.
    //
    // The failure ALWAYS surfaces as `CnosVarRequiredError` (the rule), never the raw transport
    // error — but when a transport failure caused the unresolvability it is preserved as the
    // `cause` so the caller gets both the configuration meaning and the actionable underlying
    // error. Mirrors Go's `errors.Join(ErrVarRequired, <transport error>)`.
    if (required && !this.requiredKeysResolvable(group)) {
      const key = this.unresolvedRequiredKey(group) ?? group;
      throw failure !== undefined
        ? new CnosVarRequiredError(key, { cause: failure })
        : new CnosVarRequiredError(key);
    }

    if (failure !== undefined) {
      this.warn(
        `[cnos:var] prefetch of group "${group}" failed (falling back to static/default): ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
    }
  }

  private requiredKeysResolvable(group: string): boolean {
    return this.unresolvedRequiredKey(group) === undefined;
  }

  /** The first required key of `group` that resolves from no overlay tier, if any. */
  private unresolvedRequiredKey(group: string): string | undefined {
    if (!this.overlayReader) {
      return undefined;
    }

    return this.requiredKeys(group).find((key) => this.overlayReader?.(key) === undefined);
  }

  /**
   * Start a poller per PULL-ONLY prefetch source honoring `pollInterval`, with the
   * `If-None-Match` short-circuit.
   *
   * CANONICAL RULE (identical in the Go SDK): polling is keyed off the provider's declared
   * CAPABILITIES, never the transport name — poll only when the provider does NOT implement
   * `subscribe`. A subscribe-capable provider (rpc) relies on its stream; adding a poll loop
   * behind it would double-fetch and, worse, silently paper over a TERMINAL subscription, which
   * is the exact failure the terminal state exists to advertise. A `pollInterval` declared on a
   * subscribe-capable source is ignored — warn once so the config is not silently dropped.
   */
  startPollers(): void {
    if (this.closed) {
      return;
    }

    const warnedSources = new Set<string>();

    for (const group of this.prefetchGroups()) {
      const definition = this.vars[group];
      const source = definition ? this.varSources[definition.source] : undefined;

      if (!definition || !source) {
        continue;
      }

      const interval = parseDuration(source.pollInterval);

      if (interval === undefined || interval <= 0) {
        continue;
      }

      let provider: VarSourceProvider;

      try {
        provider = this.provider(definition.source);
      } catch {
        // No transport module registered — nothing to poll with; the overlay serves the
        // static/default tiers and `prefetch()` has already warned about the gap.
        continue;
      }

      if (provider.subscribe) {
        if (!warnedSources.has(definition.source)) {
          warnedSources.add(definition.source);
          this.warn(
            `[cnos:var] source "${definition.source}" declares pollInterval but its transport ` +
              `("${source.transport}") supports subscribe; the subscription is authoritative and ` +
              'pollInterval is ignored. Remove it from the manifest to silence this warning.',
          );
        }

        continue;
      }

      this.schedulePoll(group, definition.source, interval, interval, 0);
    }
  }

  /**
   * Transactional startup: prefetch, then pollers, then subscriptions. If ANY step throws, every
   * timer and subscription this attempt created is rolled back before the error propagates, so a
   * retry (permitted since the round-1 latch fix) starts from a clean slate instead of
   * duplicating live timers/streams from a half-finished attempt.
   */
  async start(): Promise<void> {
    if (this.closed) {
      // A closed runtime can never become ready. Reporting success here would hand the caller a
      // runtime with no pollers, no subscriptions and no providers, silently serving only the
      // static/default tiers. Mirrors the Go SDK's `ErrVarClosed`.
      throw new CnosVarClosedError();
    }

    const timersBefore = new Set(this.timers);
    const subscriptionsBefore = new Set(this.subscriptions);
    const providersBefore = new Set(this.providers.keys());

    const controller = new AbortController();
    this.startAbort = controller;

    const attempt = this.runStart(timersBefore, subscriptionsBefore, providersBefore, controller.signal);
    this.startAttempt = attempt;

    try {
      await attempt;
    } finally {
      if (this.startAttempt === attempt) {
        this.startAttempt = undefined;
      }
      if (this.startAbort === controller) {
        this.startAbort = undefined;
      }
    }
  }

  private async runStart(
    timersBefore: Set<ReturnType<typeof setTimeout>>,
    subscriptionsBefore: Set<() => void>,
    providersBefore: Set<string>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.prefetch(signal);
      // `close()` can have run while prefetch was in flight. Creating pollers, subscriptions or
      // providers now would create them behind close()'s back, and nothing would ever release
      // them. Re-checked after every await and before ANY long-lived resource is created.
      this.assertOpen();
      this.startPollers();
      this.startSubscriptions();
      this.assertOpen();
    } catch (error) {
      await this.rollbackStart(timersBefore, subscriptionsBefore, providersBefore);
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new CnosVarClosedError();
    }
  }

  /** Undo everything the failed start attempt created; pre-existing resources are untouched. */
  private async rollbackStart(
    timersBefore: Set<ReturnType<typeof setTimeout>>,
    subscriptionsBefore: Set<() => void>,
    providersBefore: Set<string>,
  ): Promise<void> {
    for (const timer of Array.from(this.timers)) {
      if (!timersBefore.has(timer)) {
        clearTimeout(timer);
        this.timers.delete(timer);
      }
    }

    for (const stop of Array.from(this.subscriptions)) {
      if (!subscriptionsBefore.has(stop)) {
        try {
          stop();
        } catch {
          /* provider unsubscribe is best-effort */
        }

        this.subscriptions.delete(stop);
      }
    }

    // Providers too. A provider whose `subscribe()` allocated resources and then threw stayed
    // cached and was never closed, so the retry reused a possibly poisoned instance and the
    // allocation leaked for the process lifetime.
    const doomed: Array<Promise<void>> = [];

    for (const [sourceId, provider] of Array.from(this.providers)) {
      if (!providersBefore.has(sourceId)) {
        this.providers.delete(sourceId);
        doomed.push(provider.close().catch(() => undefined));
      }
    }

    await Promise.all(doomed);
  }

  /**
   * Start a live subscription per prefetch source whose provider implements `subscribe`
   * (push transports: rpc first, ws/sse later). Pushed batches route through the SAME
   * validated ingest path as pulls; the provider owns reconnect/backoff internally. Pollers
   * still cover pull-only (http) sources — the two are complementary, keyed off the provider's
   * declared capabilities, never the transport name.
   */
  startSubscriptions(): void {
    if (this.closed) {
      return;
    }

    const scopesBySource = new Map<string, VarScope[]>();

    for (const [group, definition] of Object.entries(this.vars)) {
      if (definition.mode !== 'prefetch') {
        continue;
      }

      const scopes = scopesBySource.get(definition.source) ?? [];
      scopes.push({ group });
      scopesBySource.set(definition.source, scopes);
    }

    for (const [sourceId, scopes] of scopesBySource) {
      let provider: VarSourceProvider;

      try {
        provider = this.provider(sourceId);
      } catch {
        // Missing/unavailable transport module — the overlay serves static/default tiers.
        continue;
      }

      if (!provider.subscribe) {
        continue;
      }

      const stop = provider.subscribe(scopes, (event) => {
        this.applyPushEvent(event);
      });

      for (const scope of scopes) {
        const group = scope.group ?? scope.key ?? '';
        if (group) {
          this.store.recordSubscription(group, group.split('.')[0] ?? group, 'active');
        }
      }

      this.subscriptions.add(stop);
    }
  }

  /**
   * Route a push event. A `batch` goes through the SAME validated ingest as a pull; a `no-head`
   * is a deactivation and clears the scope's runtime tier. Dropping `no-head` here is what let
   * an rpc consumer — which normally has no poller at all — serve a deactivated revision
   * indefinitely, with no pull to ever converge on.
   */
  private applyPushEvent(event: VarPushEvent): void {
    if (this.closed) {
      return;
    }

    if (event.kind === 'no-head') {
      const scope = event.scope;

      if (!scope) {
        return;
      }

      this.ingestNoHead('', scope);
      return;
    }

    const batch = event.batch;

    if (!batch) {
      return;
    }

    const scope = event.scope ?? Object.keys(batch.values)[0]?.split('.')[0];

    if (!scope) {
      return;
    }

    const group = scope.split('.')[0] ?? '';

    if (!group) {
      return;
    }

    this.ingest(group, scope, batch);
  }

  private schedulePoll(group: string, sourceId: string, interval: number, delay: number, attempt: number): void {
    if (this.closed) {
      return;
    }

    const timer = setTimeout(() => {
      this.timers.delete(timer);

      void this.fetchScope(sourceId, group, { group }, group)
        .then(() => {
          this.schedulePoll(group, sourceId, interval, interval, 0);
        })
        .catch(() => {
          const nextAttempt = attempt + 1;
          const backoff = Math.min(DEFAULT_BACKOFF_MS * 2 ** nextAttempt, MAX_BACKOFF_MS);
          const jittered = backoff / 2 + Math.random() * (backoff / 2);
          this.schedulePoll(group, sourceId, interval, jittered, nextAttempt);
        });
    }, delay);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    this.timers.add(timer);
  }

  // ---- Refresh -----------------------------------------------------------

  async refreshVar(key: string): Promise<void> {
    const normalized = key.startsWith(VAR_NAMESPACE_PREFIX) ? key : `${VAR_NAMESPACE_PREFIX}${key}`;
    const path = normalized.slice(VAR_NAMESPACE_PREFIX.length);
    const group = path.split('.')[0] ?? '';
    const definition = this.vars[group];

    if (!definition) {
      return;
    }

    // Honor ttl: no-op when the current snapshot is still fresh.
    const snap = this.store.runtimeSnapshot(normalized);

    if (snap && snap.freshness === 'fresh') {
      return;
    }

    const required = this.requiredKeys(group).includes(normalized);
    let outcome: 'ingested' | 'rejected' | 'no-head' | 'not-modified' | 'superseded' | undefined;

    try {
      outcome = await this.fetchScope(definition.source, group, { group }, group);
    } catch (error) {
      if (required) {
        throw error;
      }
      this.warn(
        `[cnos:var] refresh of "${normalized}" failed (serving last-known-good): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    // `fetchScope` returns `rejected` WITHOUT throwing, so the catch above never saw a revision
    // the authority served but validation refused — a required key silently reported success
    // where Go returns ErrVarRequired (Go's ingest rejection surfaces as a fetch error). A
    // `no-head` deliberately does NOT reject here: it is a definitive answer ("use the fallback
    // tiers"), and a required key with no fallback stays fail-fast LAZILY at read time.
    if (required && outcome === 'rejected') {
      throw new CnosVarRequiredError(normalized);
    }
  }

  /**
   * Explicit caller-driven refresh of EVERY configured group with a source — prefetch AND
   * ondemand alike. `refreshVars()` is a caller request, so unlike the automatic lifecycle
   * (where prefetch/ondemand governs whether CNOS fetches on its own) its scope is every group.
   *
   * FAILURE CONTRACT (canonical, mirrors Go's `RefreshVars`): every group is attempted to
   * completion — no short-circuit — and if ANY failed the returned promise REJECTS with an
   * aggregate of the per-group failures; it resolves only when every group succeeded. A
   * `not-modified` and a `no-head` are SUCCESSFUL outcomes (a `no-head` applies the normal
   * deactivation path), never failures.
   *
   * The rejection KIND mirrors Go: when a group carrying a REQUIRED key failed, the rejection is
   * `CnosVarRequiredError` (required-kind), carrying the full aggregate as its `cause`; otherwise
   * it is an `AggregateError` (other-kind). Background pollers stay best-effort (warn, never
   * propagate) — this contract is ONLY for the explicit API.
   */
  async refreshVars(): Promise<void> {
    const failures: Array<{ group: string; error: unknown; required: boolean }> = [];
    const tasks: Array<Promise<void>> = [];

    for (const [group, definition] of Object.entries(this.vars)) {
      if (!definition) {
        continue;
      }

      tasks.push(
        this.fetchScope(definition.source, group, { group }, group).then(
          () => undefined,
          (error: unknown) => {
            failures.push({ group, error, required: this.groupIsRequired(group) });
            this.warn(
              `[cnos:var] refreshVars: group "${group}" failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        ),
      );
    }

    await Promise.all(tasks);

    if (failures.length === 0) {
      return;
    }

    const causes = failures.map((failure) => failure.error);
    const aggregate = new AggregateError(
      causes,
      `refreshVars: ${failures.length} var group(s) failed to refresh (${failures.map((f) => `"${f.group}"`).join(', ')}).`,
    );

    const requiredFailure = failures.find((failure) => failure.required);

    if (requiredFailure) {
      // A required-group failure surfaces as required-kind (as Go prefers requiredErr), with the
      // whole aggregate preserved as the cause so no per-group failure is lost.
      const key = this.unresolvedRequiredKey(requiredFailure.group) ?? requiredFailure.group;
      throw new CnosVarRequiredError(key, { cause: aggregate });
    }

    throw aggregate;
  }

  async close(): Promise<void> {
    this.closed = true;

    // Abort the in-flight prefetch FIRST so its network wait is cancelled promptly, THEN wait for
    // the startup attempt to stop. Without the abort, close() would block until the in-flight
    // pull settled on its own (up to the transport's own timeout, e.g. 30s for http) — the abort
    // is what makes close() return promptly. The aborted attempt re-checks `closed` and rolls
    // back whatever it created (see runStart/rollbackStart), so once it has settled the sets
    // below are complete. Mirrors Go's ctx-derived prefetch cancellation.
    this.startAbort?.abort(new CnosVarClosedError());

    const attempt = this.startAttempt;

    if (attempt) {
      await attempt.catch(() => undefined);
    }

    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();

    for (const stop of this.subscriptions) {
      try {
        stop();
      } catch {
        /* provider unsubscribe is best-effort */
      }
    }
    this.subscriptions.clear();

    await Promise.all(
      Array.from(this.providers.values()).map((provider) =>
        provider.close().catch(() => undefined),
      ),
    );
    this.providers.clear();
    this.store.close();
  }
}
