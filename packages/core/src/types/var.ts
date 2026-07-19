/**
 * Runtime variables (`var.*`) — the third value tier alongside `value.*` and `secret.*`.
 *
 * `var.*` is mutable, non-secret runtime configuration owned by a remote authority
 * (allow/block lists, entitlements, kill switches, execution-lane policies). These
 * types cover the W1 authoring model only: manifest sections, projection blocks, and
 * the snapshot / provider contracts. No fetch/watch/store runtime logic lives here.
 */

/** Distribution transports for a var source, in priority order. */
export type VarTransport = 'rpc' | 'http' | 'ws' | 'sse';

/** Fetch mode for a var group. `prefetch` resolves before ready(); `ondemand` never blocks ready. */
export type VarFetchMode = 'prefetch' | 'ondemand';

/**
 * A named var source in the manifest (authoring surface). `auth` and `verify` carry
 * `secret.*` references only — never inline secret material.
 */
export interface VarSourceDefinition {
  transport: VarTransport;
  url: string;
  /** Map of auth slot -> `secret.*` reference (e.g. `{ bearer: 'secret.ops.token' }`). */
  auth?: Record<string, string>;
  /** Poll interval for pull-based transports (e.g. `30s`). */
  pollInterval?: string;
  /** `secret.*` reference used to verify inbound push (HMAC/bearer) on a latching receiver. */
  verify?: string;
}

/** Normalized var source. `auth` is always present (defaults to `{}`); refs stay as strings. */
export interface NormalizedVarSourceDefinition {
  transport: VarTransport;
  url: string;
  auth: Record<string, string>;
  pollInterval?: string;
  verify?: string;
}

/**
 * A var group in the manifest maps `var.<group>.*` keys to a declared source.
 * Read sites never name a remote; repointing a group is a manifest-only change.
 */
export interface VarGroupDefinition {
  source: string;
  mode: VarFetchMode;
  /** On-demand staleness window (e.g. `60s`). */
  ttl?: string;
  /** Fail-closed freshness/lease window (e.g. `10m`). Past it, snapshots report stale/expired. */
  lease?: string;
}

export type DocumentFieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

/** A single field rule inside a document schema. */
export interface DocumentFieldRule {
  type: DocumentFieldType;
  required?: boolean;
  enum?: unknown[];
  pattern?: string;
}

/** Raw (pre-normalization) document schema as authored in the manifest. */
export interface DocumentSchemaInput {
  fields?: Record<string, DocumentFieldRule>;
  /** Whether unknown fields are allowed. Defaults to `false` (unknown fields rejected). */
  additionalProperties?: boolean;
}

/**
 * A normalized document schema, keyed in the manifest by `schemaId/version`
 * (e.g. `agentic-lanes/v1`). Binds to a var key via `ConfigSpecRule.document`.
 */
export interface DocumentSchemaDefinition {
  fields: Record<string, DocumentFieldRule>;
  additionalProperties: boolean;
}

/**
 * Projected var source definition (server projection). Identical shape to the
 * normalized source: it carries `secret.*` refs only, never resolved material.
 */
export type ProjectedVarSourceDefinition = NormalizedVarSourceDefinition;

/** Which precedence tier produced a var value. */
export type VarSnapshotSource = 'runtime' | 'static' | 'default';

/** Freshness of a var snapshot, driven by the group's ttl/lease window. */
export type VarSnapshotFreshness = 'fresh' | 'stale' | 'expired';

/** Retained last-known-good pointer when the current fetch state is degraded. */
export interface VarSnapshotLastKnownGood {
  generation: number;
  revision: string;
}

/**
 * Immutable metadata describing a resolved var value. TYPES ONLY in W1 — no runtime
 * produces these yet; the runtime SDK (W3) constructs them at ingest.
 */
export interface VarSnapshot {
  /** Monotonic per scope; increases on every activation (including rollback). */
  generation: number;
  /** Immutable content hash of the document. */
  revision: string;
  /** Document schema identifier (e.g. `agentic-lanes`). */
  schemaId?: string;
  /** Document schema version (e.g. `v1`). */
  schemaVersion?: string;
  /** When the revision was activated. */
  effectiveAt: string;
  /** When this SDK fetched/received it. */
  observedAt: string;
  source: VarSnapshotSource;
  freshness: VarSnapshotFreshness;
  /** Optional expiry/lease deadline. */
  leaseExpiresAt?: string;
  lastKnownGood?: VarSnapshotLastKnownGood;
}

/** Scope of a var fetch — a single key or a whole group. */
export interface VarScope {
  key?: string;
  group?: string;
}

/**
 * An immutable batch of var values for a scope, as delivered by a provider.
 * Mirrors the http response shape (`{ generation, revision, schemaId, effectiveAt, values }`).
 * Batch pushes covering multiple keys commit atomically as one transaction.
 */
export interface VarSnapshotBatch {
  generation: number;
  revision: string;
  schemaId?: string;
  effectiveAt: string;
  values: Record<string, unknown>;
}

/** Context handed to a provider factory — resolves `secret.*` auth refs to material. */
export interface VarSourceProviderContext {
  resolveSecret(ref: string): Promise<string>;
}

/**
 * The provider contract every transport module implements. TYPES ONLY in W1 —
 * concrete providers arrive with the runtime SDK (W3).
 */
export interface VarSourceProvider {
  pull(scope: VarScope, knownRevision?: string): Promise<VarSnapshotBatch>;
  subscribe?(scopes: VarScope[], onBatch: (batch: VarSnapshotBatch) => void): () => void;
  close(): Promise<void>;
}

/** Factory used by runtimes and provider packages to construct var source clients. */
export type VarSourceProviderFactory = (
  def: ProjectedVarSourceDefinition,
  ctx: VarSourceProviderContext,
) => VarSourceProvider;

/**
 * A transport-keyed provider module, registered like a secret vault provider factory.
 * The runtime selects the module whose `transport` matches a var source's declared transport.
 */
export interface VarSourceProviderModule {
  readonly transport: VarTransport;
  create: VarSourceProviderFactory;
}

/**
 * A resolved var value plus its snapshot metadata, returned by `varSnapshot(path)`.
 * A cheap, in-memory read usable per request. When the value comes from a static/default
 * tier, `generation`/`revision`/`effectiveAt`/`observedAt` are absent.
 */
export interface ResolvedVarSnapshot {
  value: unknown;
  /** Monotonic per scope; present only when the runtime tier produced the value. */
  generation?: number;
  /** Immutable content hash; present only for the runtime tier. */
  revision?: string;
  schemaId?: string;
  schemaVersion?: string;
  effectiveAt?: string;
  observedAt?: string;
  source: VarSnapshotSource;
  freshness: VarSnapshotFreshness;
  leaseExpiresAt?: string;
  lastKnownGood?: VarSnapshotLastKnownGood;
}

/** Per-scope observability record. Never carries secret material or full sensitive documents. */
export interface VarScopeStatus {
  /** Server head generation when known (last successful pull); absent for static/default-only scopes. */
  desiredGeneration?: number;
  /** Generation this process currently serves; 0 when no runtime head has been applied. */
  appliedGeneration: number;
  revision?: string;
  source: VarSnapshotSource | 'none';
  /** Age of the applied snapshot in seconds. */
  snapshotAge?: number;
  freshness: VarSnapshotFreshness | 'none';
  lastRefreshAt?: string;
  lastError: string | null;
  lastRejected?: { revision?: string; reason: string; at: string };
}

/** Full observability report keyed by scope. */
export type VarStatusReport = Record<string, VarScopeStatus>;

/** Watch callback fired only after a validated commit. */
export type VarWatchCallback = (
  next: ResolvedVarSnapshot,
  prev: ResolvedVarSnapshot | undefined,
) => void;
