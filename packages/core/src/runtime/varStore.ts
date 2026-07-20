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
  private readonly scopes = new Map<string, StoredScope>();
  private readonly meta = new Map<string, ScopeMeta>();
  private readonly watchers = new Set<Watcher>();
  private readonly groups: Record<string, VarGroupDefinition>;
  private readonly schema: Record<string, ConfigSpecRule>;
  private readonly documents: Record<string, DocumentSchemaDefinition>;
  private readonly clockMs: () => number;
  private readonly now: () => string;
  private readonly warn: (message: string) => void;
  private closed = false;

  constructor(options: LiveVarStoreOptions) {
    this.groups = options.groups;
    this.schema = options.schema;
    this.documents = options.documents;
    this.clockMs = options.clockMs ?? (() => Date.now());
    this.now = options.now ?? (() => new Date().toISOString());
    this.warn = options.warn ?? ((message: string) => console.warn(message));
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

    const previousSnapshots = this.snapshotWatchers();
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

    this.fireWatchers(previousSnapshots);

    return { ok: true };
  }

  /** Runtime-tier lookup used by the overlay seam. Returns `undefined` when no runtime head applies. */
  readRuntimeVar(key: string): unknown {
    const path = key.slice(VAR_NAMESPACE_PREFIX.length);
    const stored = this.findScope(path);

    if (!stored) {
      return undefined;
    }

    return extractForScope(stored.scope, path, stored.batch.values ?? {});
  }

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
    const stored = this.findScope(path);

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
    return this.findScope(path) !== undefined;
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
      const stored = this.findScope(path);
      const group = stored?.group ?? path.split('.')[0] ?? path;
      const meta = this.meta.get(stored?.scope ?? path) ?? this.meta.get(group);

      let freshness: VarScopeStatus['freshness'] = 'none';
      let snapshotAge: number | undefined;

      if (stored) {
        freshness = this.freshnessFor(group, stored.observedAtMs).freshness;
        snapshotAge = Math.floor((this.clockMs() - stored.observedAtMs) / 1000);
      }

      report[path] = {
        ...(meta?.desiredGeneration !== undefined ? { desiredGeneration: meta.desiredGeneration } : {}),
        appliedGeneration: stored?.batch.generation ?? 0,
        ...(stored?.batch.revision !== undefined ? { revision: stored.batch.revision } : {}),
        source: stored ? 'runtime' : 'none',
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

  private snapshotWatchers(): Map<string, ResolvedVarSnapshot | undefined> {
    const map = new Map<string, ResolvedVarSnapshot | undefined>();

    for (const key of this.watchedKeys()) {
      map.set(key, this.runtimeSnapshot(key));
    }

    return map;
  }

  private fireWatchers(previous: Map<string, ResolvedVarSnapshot | undefined>): void {
    // Snapshot the registry BEFORE dispatching: a watcher registered from inside a callback
    // must not be visited by the pass that is already running — it never observed the commit
    // that pass is reporting. (Unsubscribing mid-pass still suppresses a pending fire, which
    // is checked against the live set below.) Mirrors the Go SDK's `notify`.
    for (const watcher of Array.from(this.watchers)) {
      if (!this.watchers.has(watcher)) {
        continue;
      }

      const keys = watcher.prefix
        ? Object.keys(this.schema).filter((schemaKey) => schemaKey.startsWith(watcher.prefix as string))
        : [watcher.key];

      for (const key of keys) {
        const next = this.runtimeSnapshot(key);

        if (!next) {
          continue;
        }

        const prev = previous.get(key);

        // Revision is content-addressed, so an equal revision means equal content and there is
        // nothing for a watcher to react to. Generation is deliberately excluded: a push without
        // an explicit revision is stamped with a wall-clock generation, so gating on it would
        // wake every watcher on each replay of an identical document.
        if (prev && prev.revision === next.revision) {
          continue;
        }

        try {
          watcher.callback(next, prev);
        } catch (error) {
          this.warn(
            `[cnos:var] watch callback for "${key}" threw (ignored): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  close(): void {
    this.closed = true;
    this.watchers.clear();
  }
}
