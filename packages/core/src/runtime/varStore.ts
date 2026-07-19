import type { ConfigSpecRule } from '../types/spec.js';
import type {
  DocumentSchemaDefinition,
  ResolvedVarSnapshot,
  VarGroupDefinition,
  VarScopeStatus,
  VarSnapshotBatch,
  VarSnapshotFreshness,
  VarStatusReport,
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
}

interface ScopeMeta {
  group: string;
  lastError: string | null;
  lastRefreshAt?: string;
  lastRejected?: { revision?: string; reason: string; at: string };
  desiredGeneration?: number;
  warnedRejections: Set<string>;
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

function getRelative(values: Record<string, unknown>, relative: string): unknown {
  if (Object.prototype.hasOwnProperty.call(values, relative)) {
    return values[relative];
  }

  let current: unknown = values;

  for (const segment of relative.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/** Extract the value for `path` (var key minus `var.`) from a batch stored under `scope`. */
function extractForScope(scope: string, path: string, values: Record<string, unknown>): unknown {
  if (scope === path) {
    return values;
  }

  const prefix = `${scope}.`;

  if (path.startsWith(prefix)) {
    return getRelative(values, path.slice(prefix.length));
  }

  return undefined;
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
    const issues = this.validateBatch(scope, group, batch.values ?? {});

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
    this.scopes.set(scope, {
      scope,
      group,
      batch,
      observedAt: this.now(),
      observedAtMs: nowMs,
      effectiveAt: batch.effectiveAt,
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
      ...(freshness !== 'fresh'
        ? { lastKnownGood: { generation: stored.batch.generation, revision: stored.batch.revision } }
        : {}),
    };
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

  status(): VarStatusReport {
    const report: VarStatusReport = {};
    const scopeKeys = new Set<string>([...this.scopes.keys(), ...this.meta.keys()]);

    for (const scope of scopeKeys) {
      const stored = this.scopes.get(scope);
      const meta = this.meta.get(scope);
      const group = stored?.group ?? meta?.group ?? scope.split('.')[0] ?? scope;

      let freshness: VarScopeStatus['freshness'] = 'none';
      let snapshotAge: number | undefined;

      if (stored) {
        freshness = this.freshnessFor(group, stored.observedAtMs).freshness;
        snapshotAge = Math.floor((this.clockMs() - stored.observedAtMs) / 1000);
      }

      report[scope] = {
        ...(meta?.desiredGeneration !== undefined ? { desiredGeneration: meta.desiredGeneration } : {}),
        appliedGeneration: stored?.batch.generation ?? 0,
        ...(stored?.batch.revision !== undefined ? { revision: stored.batch.revision } : {}),
        source: stored ? 'runtime' : 'none',
        ...(snapshotAge !== undefined ? { snapshotAge } : {}),
        freshness,
        ...(meta?.lastRefreshAt !== undefined ? { lastRefreshAt: meta.lastRefreshAt } : {}),
        lastError: meta?.lastError ?? null,
        ...(meta?.lastRejected !== undefined ? { lastRejected: meta.lastRejected } : {}),
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
    for (const watcher of this.watchers) {
      const keys = watcher.prefix
        ? Object.keys(this.schema).filter((schemaKey) => schemaKey.startsWith(watcher.prefix as string))
        : [watcher.key];

      for (const key of keys) {
        const next = this.runtimeSnapshot(key);

        if (!next) {
          continue;
        }

        const prev = previous.get(key);

        if (prev && prev.revision === next.revision && prev.generation === next.generation) {
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
