import type { ConfigSpecRule } from '../types/spec.js';
import type {
  DocumentSchemaDefinition,
  ResolvedVarSnapshot,
  VarGroupDefinition,
  VarScopeStatus,
  VarSnapshotBatch,
  VarSnapshotFreshness,
  VarSnapshotLastKnownGood,
  VarStatusReport,
  VarSubscriptionState,
  VarSubscriptionStatus,
  VarWatchCallback,
} from '../types/var.js';
import type { ValidationIssue } from '../types/plugin.js';
import { validateDocumentValue } from '../validation/validateVars.js';
import { parseDuration } from '../utils/duration.js';
import { VAR_NAMESPACE_PREFIX } from './readVar.js';

interface StoredScope {
  scope: string;
  group: string;
  batch: VarSnapshotBatch;
  observedAt: string;
  observedAtMs: number;
  effectiveAt: string;
  /** The revision this commit displaced — the last one validated and served while fresh. */
  lastKnownGood?: VarSnapshotLastKnownGood;
}

interface ScopeMeta {
  group: string;
  lastError: string | null;
  lastRefreshAt?: string;
  lastRejected?: { revision?: string; reason: string; at: string };
  desiredGeneration?: number;
  warnedRejections: Set<string>;
  subscription?: VarSubscriptionStatus;
}

interface Watcher {
  key: string;
  prefix?: string;
  callback: VarWatchCallback;
}

/**
 * One immutable watcher delivery, frozen at COMMIT time. Both `prev` and `next` are captured
 * around the mutation that produced them, never re-read at dispatch time — otherwise a
 * reactivation triggered from inside a deactivation callback would make the watchers visited
 * later in the same pass observe the reactivated value and never see the fallback transition.
 */
interface NotifyEntry {
  watcher: Watcher;
  key: string;
  next: ResolvedVarSnapshot;
  prev: ResolvedVarSnapshot | undefined;
}

/** Everything captured BEFORE a mutation so the post-commit event can be built. */
interface NotifyCapture {
  watchers: Watcher[];
  previous: Map<string, ResolvedVarSnapshot | undefined>;
}

export interface LiveVarStoreOptions {
  groups: Record<string, VarGroupDefinition>;
  schema: Record<string, ConfigSpecRule>;
  documents: Record<string, DocumentSchemaDefinition>;
  /** Millisecond clock (test seam). */
  clockMs?: () => number;
  /** ISO timestamp clock (test seam). */
  now?: () => string;
  /** stderr warn seam. */
  warn?: (message: string) => void;
  /**
   * Resolver for the NON-runtime overlay tiers (② static `value.<group>.<rest>` → ③ schema
   * `default`). The store owns only the runtime tier, so it needs this seam to report what a
   * key resolves to once its runtime head is removed — which is exactly what a watcher must be
   * handed on a deactivation, and what `status()` reports as the serving `source`.
   */
  fallbackSnapshot?: (key: string) => ResolvedVarSnapshot | undefined;
}

export interface IngestResult {
  ok: boolean;
  issues?: ValidationIssue[];
}

/**
 * Extract the value for `path` (a var key minus the `var.` prefix) from a stored batch.
 * Canonical uniform keying: every batch — key- OR group-scoped — has its `values` keyed
 * by the FULL stripped key, so extraction is a single lookup with no scope-relative math.
 */
function extractForScope(_scope: string, path: string, values: Record<string, unknown>): unknown {
  return values[path];
}

/**
 * Whether the batch actually CARRIES `path`. A key whose serving scope exists but whose last
 * revision omitted it has no runtime tier at all: reads, snapshots and status must all fall
 * through to ② static / ③ default rather than reporting `source: 'runtime', value: undefined`.
 * Own-property based so a legitimately `null` value still counts as present. Matches the Go
 * store, where a missing record is simply a miss.
 */
function hasValueForScope(path: string, values: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(values, path);
}

/**
 * The authority allocates `generation` as an int64. JavaScript numbers are exact only up to
 * `Number.MAX_SAFE_INTEGER`, so anything larger has ALREADY lost precision by the time it
 * reaches here (a rounded int64 is never a safe integer, which is exactly what this detects).
 * Reject the batch instead of committing a corrupted generation — a silently wrong generation
 * breaks optimistic concurrency, replay, and watcher dedupe. Go carries the value as a native
 * int64 and needs no equivalent guard.
 */
function validateGeneration(scope: string, generation: unknown): ValidationIssue[] {
  if (typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0) {
    return [];
  }

  return [
    {
      code: 'var.generation-range',
      key: scope,
      message:
        `Var scope "${scope}" received generation ${String(generation)}, which is outside the ` +
        `exactly representable range 0..${Number.MAX_SAFE_INTEGER} for this SDK. ` +
        'Configure the var authority to allocate generations below 2^53.',
    },
  ];
}

function validateScalar(key: string, rule: ConfigSpecRule, value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (rule.type) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const matches =
      rule.type === 'array'
        ? Array.isArray(value)
        : rule.type === 'object'
          ? Boolean(value) && typeof value === 'object' && !Array.isArray(value)
          : typeof value === rule.type;

    if (!matches) {
      issues.push({ code: 'var.type', key, message: `Var "${key}" expected type ${rule.type} but got ${actual}.` });
    }
  }

  if (rule.enum && !rule.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    issues.push({
      code: 'var.enum',
      key,
      message: `Var "${key}" must be one of ${rule.enum.map((entry) => JSON.stringify(entry)).join(', ')}.`,
    });
  }

  if (rule.pattern !== undefined) {
    if (typeof value !== 'string') {
      issues.push({ code: 'var.pattern', key, message: `Var "${key}" must be a string to match pattern ${rule.pattern}.` });
    } else {
      let ok = false;
      try {
        ok = new RegExp(rule.pattern).test(value);
      } catch {
        ok = false;
      }
      if (!ok) {
        issues.push({ code: 'var.pattern', key, message: `Var "${key}" does not match pattern ${rule.pattern}.` });
      }
    }
  }

  return issues;
}

/**
 * The orchestrator-owned live var store: per-scope immutable snapshot objects, atomic batch
 * commits (validate-before-swap), overlay reads, freshness/lease evaluation, watch notification,
 * and observability. Pure in-memory — no network. Providers/pollers live in the manager.
 */
export class LiveVarStore {
  private scopes = new Map<string, StoredScope>();
  private readonly meta = new Map<string, ScopeMeta>();
  private readonly watchers = new Set<Watcher>();
  private readonly groups: Record<string, VarGroupDefinition>;
  private readonly schema: Record<string, ConfigSpecRule>;
  private readonly documents: Record<string, DocumentSchemaDefinition>;
  private readonly clockMs: () => number;
  private readonly now: () => string;
  private readonly warn: (message: string) => void;
  private fallbackSnapshot: ((key: string) => ResolvedVarSnapshot | undefined) | undefined;
  private closed = false;
  /**
   * Monotonic per-scope counter bumped on every AUTHORITATIVE application (an accepted ingest or
   * a `no-head` removal). A pull captures it before issuing its request and applies only if it
   * is unchanged on completion — see {@link scopeEpoch}.
   */
  private readonly epochs = new Map<string, number>();
  /** Committed-but-undispatched notification events, in commit order. */
  private readonly notifyQueue: NotifyEntry[][] = [];
  private dispatching = false;

  constructor(options: LiveVarStoreOptions) {
    this.groups = options.groups;
    this.schema = options.schema;
    this.documents = options.documents;
    this.clockMs = options.clockMs ?? (() => Date.now());
    this.now = options.now ?? (() => new Date().toISOString());
    this.warn = options.warn ?? ((message: string) => console.warn(message));
    this.fallbackSnapshot = options.fallbackSnapshot;
  }

  /** Wire (or replace) the static/default tier resolver — see {@link LiveVarStoreOptions.fallbackSnapshot}. */
  setFallbackSnapshotReader(reader: (key: string) => ResolvedVarSnapshot | undefined): void {
    this.fallbackSnapshot = reader;
  }

  /**
   * The snapshot a key resolves to right now across ALL tiers: runtime head when one applies,
   * otherwise whatever the static/default seam reports. Used for watcher dispatch and status.
   */
  private effectiveSnapshot(key: string): ResolvedVarSnapshot | undefined {
    return this.runtimeSnapshot(key) ?? this.fallbackSnapshot?.(key);
  }

  /**
   * The scope's current operation epoch. CANONICAL MIXED PULL/PUSH ORDERING (both SDKs): a PUSH
   * is always applied (last-write-wins among pushes), while a PULL applies only when this value
   * is unchanged between issuing the request and its completion. Without it a stale pull
   * response could reintroduce a head the authority already deactivated, or a delayed `no-head`
   * could clear a newer pushed activation — and an ondemand rpc source, which runs no poller,
   * would stay wrong indefinitely.
   */
  scopeEpoch(scope: string): number {
    return this.epochs.get(scope) ?? 0;
  }

  private bumpEpoch(scope: string): void {
    this.epochs.set(scope, this.scopeEpoch(scope) + 1);
  }

  private metaFor(scope: string, group: string): ScopeMeta {
    let record = this.meta.get(scope);

    if (!record) {
      record = { group, lastError: null, warnedRejections: new Set() };
      this.meta.set(scope, record);
    }

    return record;
  }

  /** Schema keys that belong to `group` (with the `var.` prefix). */
  private schemaKeysForGroup(group: string): string[] {
    const prefix = `${VAR_NAMESPACE_PREFIX}${group}.`;
    return Object.keys(this.schema).filter((key) => key.startsWith(prefix));
  }

  private validateBatch(scope: string, group: string, values: Record<string, unknown>): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const schemaKey of this.schemaKeysForGroup(group)) {
      const rule = this.schema[schemaKey];

      if (!rule) {
        continue;
      }

      const path = schemaKey.slice(VAR_NAMESPACE_PREFIX.length);
      const value = extractForScope(scope, path, values);

      if (value === undefined) {
        continue;
      }

      if (rule.document !== undefined) {
        const documentSchema = this.documents[rule.document];

        if (documentSchema) {
          issues.push(
            ...validateDocumentValue(value, documentSchema, { schemaId: rule.document, path: schemaKey }),
          );
        }
      } else {
        issues.push(...validateScalar(schemaKey, rule, value));
      }
    }

    return issues;
  }

  /**
   * Validate then atomically commit a batch for `scope`. Invalid → reject the whole batch, keep
   * last-known-good, warn once per revision, record `lastRejected`. Valid → swap and notify watchers.
   */
  ingest(scope: string, group: string, batch: VarSnapshotBatch): IngestResult {
    if (this.closed) {
      return { ok: false };
    }

    const meta = this.metaFor(scope, group);
    const issues = validateGeneration(scope, batch.generation);
    issues.push(...this.validateBatch(scope, group, batch.values ?? {}));

    if (issues.length > 0) {
      const reason = issues.map((issue) => `${issue.code}: ${issue.message}`).join('; ');
      meta.lastRejected = { revision: batch.revision, reason, at: this.now() };

      if (!meta.warnedRejections.has(batch.revision)) {
        meta.warnedRejections.add(batch.revision);
        this.warn(
          `[cnos:var] rejected revision ${batch.revision} for scope "${scope}" (keeping last-known-good): ${reason}`,
        );
      }

      return { ok: false, issues };
    }

    const captured = this.captureForNotify();
    const nowMs = this.clockMs();
    // `lastKnownGood` names the revision this commit DISPLACES — the last one that was
    // validated and served while fresh. Cross-SDK canonical (mirrors the Go SDK).
    const displaced = this.scopes.get(scope);
    const lastKnownGood: VarSnapshotLastKnownGood | undefined = displaced
      ? { generation: displaced.batch.generation, revision: displaced.batch.revision }
      : undefined;

    this.scopes.set(scope, {
      scope,
      group,
      batch,
      observedAt: this.now(),
      observedAtMs: nowMs,
      effectiveAt: batch.effectiveAt,
      ...(lastKnownGood ? { lastKnownGood } : {}),
    });
    meta.desiredGeneration = batch.generation;
    this.bumpEpoch(scope);

    this.enqueueNotification(captured);

    return { ok: true };
  }

  /**
   * Drop the runtime tier for `scope` (and every scope nested beneath it) so reads fall through
   * the overlay to ② static `value.<group>.<rest>` and ③ the schema `default`.
   *
   * This is the deactivation path: the authority definitively reported "no active head" for the
   * scope (http `404 {code:"no-head"}`, rpc `no_head`). A TRANSPORT FAILURE IS NOT A NO-HEAD and
   * must never reach here — an unreachable remote keeps last-known-good, which is the whole
   * point of the lease/freshness model.
   *
   * The removal is one atomic step (the surviving entries are collected first, then swapped in
   * as a whole) so a concurrent reader observes either every key of the scope or none of them,
   * exactly like {@link ingest}. Watchers are notified because the EFFECTIVE value changed;
   * they receive the new static/default snapshot. Idempotent: removing a scope that holds no
   * runtime head is a silent no-op that fires nobody.
   */
  removeScope(scope: string, group: string, cascade = true): boolean {
    if (this.closed) {
      return false;
    }

    const doomed = Array.from(this.scopes.keys()).filter(
      (candidate) => candidate === scope || (cascade && candidate.startsWith(`${scope}.`)),
    );

    // Bump BEFORE the idempotence check: a `no-head` is an authoritative answer even when it
    // removes nothing, so an in-flight pull issued before it must still be superseded.
    this.bumpEpoch(scope);

    if (doomed.length === 0) {
      return false;
    }

    const captured = this.captureForNotify();
    // Build the surviving map fully, THEN swap the reference in one assignment: the same
    // immutable-swap discipline the Go store gets from its atomic CAS. No reader — including a
    // reentrant one from a watch callback — can ever observe a half-removed scope.
    this.scopes = new Map(
      Array.from(this.scopes.entries()).filter(([candidate]) => !doomed.includes(candidate)),
    );

    // The removed head must not masquerade as still applied in `varStatus()`.
    for (const removed of doomed) {
      const meta = this.meta.get(removed);

      if (meta) {
        delete meta.desiredGeneration;
      }
    }

    const scopeMeta = this.metaFor(scope, group);
    delete scopeMeta.desiredGeneration;

    for (const removed of doomed) {
      this.bumpEpoch(removed);
    }

    this.enqueueNotification(captured);
    return true;
  }

  /** Runtime-tier lookup used by the overlay seam. Returns `undefined` when no runtime head applies. */
  readRuntimeVar(key: string): unknown {
    const path = key.slice(VAR_NAMESPACE_PREFIX.length);
    const stored = this.servingScope(path);

    if (!stored) {
      return undefined;
    }

    return extractForScope(stored.scope, path, stored.batch.values ?? {});
  }

  /**
   * The scope serving `path`: the LONGEST committed scope that is a dot-prefix of (or equal to)
   * it. A narrower scope fully shadows the range it owns — a key missing from it does NOT fall
   * through to a broader scope. Canonical rule, identical to the Go store's `find`.
   */
  private findScope(path: string): StoredScope | undefined {
    const segments = path.split('.');

    for (let i = segments.length; i >= 1; i -= 1) {
      const scope = segments.slice(0, i).join('.');
      const stored = this.scopes.get(scope);

      if (stored) {
        return stored;
      }
    }

    return undefined;
  }

  /** The serving scope, but only when its current revision actually carries `path`. */
  private servingScope(path: string): StoredScope | undefined {
    const stored = this.findScope(path);

    if (!stored || !hasValueForScope(path, stored.batch.values ?? {})) {
      return undefined;
    }

    return stored;
  }

  private freshnessFor(group: string, observedAtMs: number): { freshness: VarSnapshotFreshness; leaseExpiresAt?: string } {
    const definition = this.groups[group];
    const ttlMs = parseDuration(definition?.ttl);
    const leaseMs = parseDuration(definition?.lease);
    const age = this.clockMs() - observedAtMs;

    let freshness: VarSnapshotFreshness = 'fresh';

    if (leaseMs !== undefined && age > leaseMs) {
      freshness = 'expired';
    } else if (ttlMs !== undefined && age > ttlMs) {
      freshness = 'stale';
    }

    return {
      freshness,
      ...(leaseMs !== undefined ? { leaseExpiresAt: new Date(observedAtMs + leaseMs).toISOString() } : {}),
    };
  }

  /** Runtime-tier snapshot for a var key, or `undefined` when no runtime head applies. */
  runtimeSnapshot(key: string): ResolvedVarSnapshot | undefined {
    const path = key.slice(VAR_NAMESPACE_PREFIX.length);
    const stored = this.servingScope(path);

    if (!stored) {
      return undefined;
    }

    const value = extractForScope(stored.scope, path, stored.batch.values ?? {});
    const { freshness, leaseExpiresAt } = this.freshnessFor(stored.group, stored.observedAtMs);

    return {
      value,
      generation: stored.batch.generation,
      revision: stored.batch.revision,
      ...(stored.batch.schemaId !== undefined ? { schemaId: stored.batch.schemaId } : {}),
      effectiveAt: stored.effectiveAt,
      observedAt: stored.observedAt,
      source: 'runtime',
      freshness,
      ...(leaseExpiresAt !== undefined ? { leaseExpiresAt } : {}),
      ...(stored.lastKnownGood ? { lastKnownGood: stored.lastKnownGood } : {}),
    };
  }

  /** Revision currently applied for `scope`, used as the pull `If-None-Match` value. */
  appliedRevision(scope: string): string | undefined {
    return this.scopes.get(scope)?.batch.revision;
  }

  hasRuntimeScope(path: string): boolean {
    return this.servingScope(path) !== undefined;
  }

  recordError(scope: string, group: string, error: unknown): void {
    const meta = this.metaFor(scope, group);
    meta.lastError = error instanceof Error ? error.message : String(error);
  }

  recordRefresh(scope: string, group: string, desiredGeneration?: number): void {
    const meta = this.metaFor(scope, group);
    meta.lastRefreshAt = this.now();
    meta.lastError = null;

    if (desiredGeneration !== undefined) {
      meta.desiredGeneration = desiredGeneration;
    }
  }

  /** Record the transport-reported state of a scope's push subscription. */
  recordSubscription(scope: string, group: string, state: VarSubscriptionState, error?: unknown, attempts?: number): void {
    const meta = this.metaFor(scope, group);
    const message = error === undefined ? undefined : error instanceof Error ? error.message : String(error);

    meta.subscription = {
      state,
      ...(message !== undefined ? { lastError: message } : {}),
      ...(attempts !== undefined ? { attempts } : {}),
      at: this.now(),
    };

    if (message !== undefined) {
      meta.lastError = message;
    }
  }

  /**
   * Observability report keyed by the FULL var key minus `var.` — the same keying the Go SDK's
   * `VarStatus()` and every wire `values` payload use. Keys come from the declared schema plus
   * whatever a committed batch actually carried; per-scope metadata (errors, rejections,
   * subscription state) is inherited by every key the scope serves.
   */
  status(): VarStatusReport {
    const report: VarStatusReport = {};
    const paths = new Set<string>();

    for (const schemaKey of Object.keys(this.schema)) {
      if (schemaKey.startsWith(VAR_NAMESPACE_PREFIX)) {
        paths.add(schemaKey.slice(VAR_NAMESPACE_PREFIX.length));
      }
    }

    for (const stored of this.scopes.values()) {
      for (const path of Object.keys(stored.batch.values ?? {})) {
        paths.add(path);
      }
    }

    for (const path of paths) {
      const stored = this.servingScope(path);
      const group = stored?.group ?? this.findScope(path)?.group ?? path.split('.')[0] ?? path;
      const meta = this.meta.get(stored?.scope ?? path) ?? this.meta.get(group);

      let freshness: VarScopeStatus['freshness'] = 'none';
      let snapshotAge: number | undefined;
      // Which tier is actually SERVING this key. With no runtime head — never applied, or the
      // head was deactivated and removed — the report names the fallback tier that took over
      // (`static`/`default`), and carries no generation/revision, so a removed head can never
      // masquerade as still applied. `none` means the key resolves nowhere at all.
      let source: VarScopeStatus['source'] = 'none';

      if (stored) {
        source = 'runtime';
        freshness = this.freshnessFor(group, stored.observedAtMs).freshness;
        snapshotAge = Math.floor((this.clockMs() - stored.observedAtMs) / 1000);
      } else {
        const fallback = this.fallbackSnapshot?.(`${VAR_NAMESPACE_PREFIX}${path}`);

        if (fallback && fallback.value !== undefined) {
          source = fallback.source;
          freshness = fallback.freshness;
        }
      }

      report[path] = {
        ...(meta?.desiredGeneration !== undefined ? { desiredGeneration: meta.desiredGeneration } : {}),
        appliedGeneration: stored?.batch.generation ?? 0,
        ...(stored?.batch.revision !== undefined ? { revision: stored.batch.revision } : {}),
        source,
        ...(snapshotAge !== undefined ? { snapshotAge } : {}),
        freshness,
        ...(meta?.lastRefreshAt !== undefined ? { lastRefreshAt: meta.lastRefreshAt } : {}),
        lastError: meta?.lastError ?? null,
        ...(meta?.lastRejected !== undefined ? { lastRejected: meta.lastRejected } : {}),
        ...(meta?.subscription !== undefined ? { subscription: meta.subscription } : {}),
      };
    }

    return report;
  }

  watch(keyOrPrefix: string, callback: VarWatchCallback): () => void {
    const watcher: Watcher = keyOrPrefix.endsWith('.*')
      ? { key: keyOrPrefix, prefix: keyOrPrefix.slice(0, -1), callback }
      : { key: keyOrPrefix, callback };

    this.watchers.add(watcher);

    return () => {
      this.watchers.delete(watcher);
    };
  }

  private watchedKeys(): string[] {
    const keys = new Set<string>();

    for (const watcher of this.watchers) {
      if (!watcher.prefix) {
        keys.add(watcher.key);
      }
    }

    // Prefix watchers observe every schema key under their prefix.
    for (const watcher of this.watchers) {
      if (watcher.prefix) {
        for (const schemaKey of Object.keys(this.schema)) {
          if (schemaKey.startsWith(watcher.prefix)) {
            keys.add(schemaKey);
          }
        }
      }
    }

    return Array.from(keys);
  }

  /**
   * Freeze the registry and the pre-mutation snapshots. Taken BEFORE the mutation: a watcher
   * registered from inside a callback must not be visited by an event committed before it
   * existed — it never observed that commit.
   */
  private captureForNotify(): NotifyCapture {
    const previous = new Map<string, ResolvedVarSnapshot | undefined>();

    for (const key of this.watchedKeys()) {
      previous.set(key, this.effectiveSnapshot(key));
    }

    return { watchers: Array.from(this.watchers), previous };
  }

  /**
   * Build the immutable delivery list for the commit that just happened, append it to the
   * queue in COMMIT ORDER, and drain. Ordering matters: a reactivation triggered from inside a
   * deactivation callback commits while this pass is mid-flight, and its event must be
   * delivered to every watcher only AFTER the deactivation event has finished being delivered
   * to every watcher — otherwise watcher #2 would see the reactivated value and never learn
   * about the fallback transition watcher #1 saw. Identical in the Go SDK.
   */
  private enqueueNotification(captured: NotifyCapture): void {
    const entries: NotifyEntry[] = [];

    for (const watcher of captured.watchers) {
      const keys = watcher.prefix
        ? Object.keys(this.schema).filter((schemaKey) => schemaKey.startsWith(watcher.prefix as string))
        : [watcher.key];

      for (const key of keys) {
        // The EFFECTIVE snapshot, not just the runtime tier: after a deactivation the key still
        // resolves — from the static/default tier — and that new value is precisely what the
        // watcher must be handed (`source: 'static' | 'default'`). Captured NOW, at commit
        // time, so a later mutation cannot rewrite what this event reports.
        const next = this.effectiveSnapshot(key);

        if (!next) {
          continue;
        }

        const prev = captured.previous.get(key);

        // Revision is content-addressed, so an equal revision means equal content and there is
        // nothing for a watcher to react to. Generation is deliberately excluded: a push without
        // an explicit revision is stamped with a wall-clock generation, so gating on it would
        // wake every watcher on each replay of an identical document. `source` participates
        // because static/default snapshots carry no revision at all: runtime→static is a real
        // change even though both sides compare equal on `revision`.
        if (prev && prev.revision === next.revision && prev.source === next.source) {
          continue;
        }

        entries.push({ watcher, key, next, prev });
      }
    }

    this.notifyQueue.push(entries);
    this.drainNotifications();
  }

  /** Deliver one queued event to every watcher before starting the next. Reentrancy-safe. */
  private drainNotifications(): void {
    if (this.dispatching) {
      // A callback of the event currently being delivered committed again. Its event is queued
      // and the loop below will pick it up — starting it here would interleave the two.
      return;
    }

    this.dispatching = true;

    try {
      let event = this.notifyQueue.shift();

      while (event) {
        for (const entry of event) {
          // Unsubscribing from inside a callback still suppresses a not-yet-delivered fire.
          if (!this.watchers.has(entry.watcher)) {
            continue;
          }

          try {
            entry.watcher.callback(entry.next, entry.prev);
          } catch (error) {
            this.warn(
              `[cnos:var] watch callback for "${entry.key}" threw (ignored): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        event = this.notifyQueue.shift();
      }
    } finally {
      this.dispatching = false;
    }
  }

  close(): void {
    this.closed = true;
    this.watchers.clear();
    this.notifyQueue.length = 0;
  }
}
