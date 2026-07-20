import { CnosVarNoHeadError, CnosVarNotModifiedError } from '../errors.js';
import type { ConfigSpecRule } from '../types/spec.js';
import type {
  DocumentSchemaDefinition,
  NormalizedVarSourceDefinition,
  ResolvedVarSnapshot,
  VarGroupDefinition,
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

    const provider = module.create(def, { resolveSecret: (ref) => this.resolveSecret(ref) });
    this.providers.set(sourceId, provider);
    return provider;
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
        this.store.recordRefresh(scopeString, group);
        return 'no-head';
      }

      this.store.recordError(scopeString, group, error);
      throw error;
    }
  }

  private appliedRevision(scopeString: string): string | undefined {
    return this.store.status()[scopeString]?.revision;
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

      // A real transport failure on a REQUIRED group is fatal — ready() rejects (fail fast),
      // unless the overlay can still satisfy every required key (static/default present).
      if (required && !this.requiredKeysResolvable(group)) {
        throw error;
      }

      this.warn(
        `[cnos:var] prefetch of group "${group}" failed (falling back to static/default): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private requiredKeysResolvable(group: string): boolean {
    if (!this.overlayReader) {
      return true;
    }

    return this.requiredKeys(group).every((key) => this.overlayReader?.(key) !== undefined);
  }

  /** Start a poller per http prefetch source honoring pollInterval, with If-None-Match short-circuit. */
  startPollers(): void {
    for (const group of this.prefetchGroups()) {
      const definition = this.vars[group];
      const source = definition ? this.varSources[definition.source] : undefined;

      if (!definition || !source || source.transport !== 'http') {
        continue;
      }

      const interval = parseDuration(source.pollInterval);

      if (interval === undefined || interval <= 0) {
        continue;
      }

      this.schedulePoll(group, definition.source, interval, interval, 0);
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

      const stop = provider.subscribe(scopes, (batch) => {
        this.ingestSubscribed(batch);
      });

      this.subscriptions.add(stop);
    }
  }

  /** Route a pushed batch through ingest, deriving its group from the full-key-keyed values. */
  private ingestSubscribed(batch: VarSnapshotBatch): void {
    if (this.closed) {
      return;
    }

    const firstKey = Object.keys(batch.values)[0];

    if (!firstKey) {
      return;
    }

    const group = firstKey.split('.')[0] ?? '';
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

    try {
      await this.fetchScope(definition.source, group, { group }, group);
    } catch (error) {
      if (required) {
        throw error;
      }
      this.warn(
        `[cnos:var] refresh of "${normalized}" failed (serving last-known-good): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
