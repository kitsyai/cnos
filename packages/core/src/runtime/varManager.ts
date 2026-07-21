import { CnosVarNoHeadError, CnosVarNotModifiedError, CnosVarRequiredError } from '../errors.js';
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
    });
    this.providers.set(sourceId, provider);
    return provider;
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
  ): Promise<'ingested' | 'rejected' | 'no-head' | 'not-modified'> {
    const provider = this.provider(sourceId);
    const knownRevision = this.appliedRevision(scopeString);

    try {
      const batch = await provider.pull(scope, knownRevision);
      const result = this.store.ingest(scopeString, group, batch);
      this.store.recordRefresh(scopeString, group, batch.generation);
      return result.ok ? 'ingested' : 'rejected';
    } catch (error) {
      if (error instanceof CnosVarNotModifiedError) {
        this.store.recordRefresh(scopeString, group);
        return 'not-modified';
      }

      if (error instanceof CnosVarNoHeadError) {
        // A DEFINITIVE answer from the authority: this scope has no active head. Clear the
        // runtime tier so the overlay restores ② static / ③ default without a redeploy
        // (acceptance #15). Contrast with the transport failure below, which is NOT an answer
        // and must retain last-known-good.
        this.applyNoHead(scopeString, group);
        this.store.recordRefresh(scopeString, group);
        return 'no-head';
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
  private applyNoHead(scopeString: string, group: string): void {
    if (this.store.removeScope(scopeString, group)) {
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
  async prefetch(): Promise<void> {
    await Promise.all(this.prefetchGroups().map((group) => this.prefetchGroup(group)));
  }

  private async prefetchGroup(group: string): Promise<void> {
    const definition = this.vars[group];

    if (!definition) {
      return;
    }

    const required = this.groupIsRequired(group);
    let failure: unknown;

    try {
      await this.fetchScope(definition.source, group, { group }, group);
    } catch (error) {
      // A missing transport module is a deployment gap, never fatal: the overlay serves the
      // static/default tiers and required-but-unresolvable reads fail fast lazily.
      if (error instanceof ProviderUnavailableError) {
        this.warn(
          `[cnos:var] prefetch group "${group}": ${error.message} Serving static/default tiers.`,
        );
        return;
      }

      failure = error;
    }

    // The required check runs after EVERY outcome, not only the thrown ones. `fetchScope`
    // returns `no-head` / `rejected` WITHOUT throwing, and both leave a required key with no
    // runtime value — a prefetch mandatory key that resolves from no tier must fail ready(),
    // exactly as the Go SDK does (`ErrVarRequired`). Checking only the catch path is what let
    // Node report a ready runtime while Go correctly refused to start.
    if (required && !this.requiredKeysResolvable(group)) {
      throw failure ?? new CnosVarRequiredError(this.unresolvedRequiredKey(group) ?? group);
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
    const timersBefore = new Set(this.timers);
    const subscriptionsBefore = new Set(this.subscriptions);

    try {
      await this.prefetch();
      this.startPollers();
      this.startSubscriptions();
    } catch (error) {
      this.rollbackStart(timersBefore, subscriptionsBefore);
      throw error;
    }
  }

  /** Undo everything the failed start attempt created; pre-existing resources are untouched. */
  private rollbackStart(
    timersBefore: Set<ReturnType<typeof setTimeout>>,
    subscriptionsBefore: Set<() => void>,
  ): void {
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
  }

  /**
   * Start a live subscription per prefetch source whose provider implements `subscribe`
   * (push transports: rpc first, ws/sse later). Pushed batches route through the SAME
   * validated ingest path as pulls; the provider owns reconnect/backoff internally. Pollers
   * still cover pull-only (http) sources — the two are complementary, keyed off the provider's
   * declared capabilities, never the transport name.
   */
  startSubscriptions(): void {
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

      this.applyNoHead(scope, scope.split('.')[0] ?? scope);
      this.store.recordRefresh(scope, scope.split('.')[0] ?? scope);
      return;
    }

    const batch = event.batch;

    if (!batch) {
      return;
    }

    const firstKey = event.scope ?? Object.keys(batch.values)[0];

    if (!firstKey) {
      return;
    }

    const group = firstKey.split('.')[0] ?? '';

    if (!group) {
      return;
    }

    this.ingest(group, group, batch);
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
    let outcome: 'ingested' | 'rejected' | 'no-head' | 'not-modified' | undefined;

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

  async refreshVars(): Promise<void> {
    const tasks: Array<Promise<unknown>> = [];

    for (const group of this.prefetchGroups()) {
      const definition = this.vars[group];

      if (!definition) {
        continue;
      }

      tasks.push(
        this.fetchScope(definition.source, group, { group }, group).catch((error: unknown) => {
          this.warn(
            `[cnos:var] refreshVars: group "${group}" failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      );
    }

    await Promise.all(tasks);
  }

  async close(): Promise<void> {
    this.closed = true;

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
