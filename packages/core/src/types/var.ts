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

/**
 * A per-key var schema rule as carried in the server projection's `schema` block.
 * Keyed by the FULL var key (e.g. `var.agentic.lanes.vinci`). Only rules for keys
 * under `var.` are projected. `default` is emitted ONLY when actually declared in the
 * manifest (JSON absence = not declared) — this mirrors the Go `VarKeyRule` presence
 * tracking so required/default enforcement round-trips across SDKs.
 */
export interface ProjectedVarKeyRule {
  /** Binds this key to a declared document schema id (e.g. `agentic-lanes/v1`). */
  document?: string;
  required?: boolean;
  type?: DocumentFieldType;
  enum?: unknown[];
  pattern?: string;
  /** Precedence tier-③ fallback; present only when declared in the manifest. */
  default?: unknown;
}

/** Which precedence tier produced a var value. */
export type VarSnapshotSource = 'runtime' | 'static' | 'default';

/** Freshness of a var snapshot, driven by the group's ttl/lease window. */
export type VarSnapshotFreshness = 'fresh' | 'stale' | 'expired';

/**
 * Pointer to the last revision that was successfully validated and served while fresh —
 * i.e. the revision that was active immediately BEFORE the current one. It is stamped at
 * commit time from the outgoing snapshot, never from the incoming one, so it always names a
 * different (earlier) revision than the snapshot carrying it. Absent on the first commit for
 * a scope. Identical semantics in the Go SDK (`LastKnownGood`).
 */
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
  /**
   * Monotonic per scope. The authority allocates an int64; the Node SDK carries it as a JS
   * number and therefore only supports the exact range `[0, Number.MAX_SAFE_INTEGER]`.
   * A batch whose generation falls outside that range is REJECTED at ingest
   * (`var.generation-range`) rather than silently rounded — see `LiveVarStore.ingest`.
   */
  generation: number;
  revision: string;
  schemaId?: string;
  effectiveAt: string;
  values: Record<string, unknown>;
}

/** Lifecycle state of a push subscription held by a transport provider. */
export type VarSubscriptionState = 'active' | 'retrying' | 'failed';

/**
 * Observable state of a source's push subscription. `failed` is TERMINAL: the provider has
 * stopped reconnecting (auth rejection, or the consecutive-failure cap was reached) and the
 * scope will receive no further pushes until the process re-subscribes.
 */
export interface VarSubscriptionStatus {
  state: VarSubscriptionState;
  /** Message of the failure that produced the current state. */
  lastError?: string;
  /** Consecutive failed connection attempts behind the current state. */
  attempts?: number;
  /** ISO timestamp of the last state transition. */
  at?: string;
}

/** Context handed to a provider factory — resolves `secret.*` auth refs to material. */
export interface VarSourceProviderContext {
  resolveSecret(ref: string): Promise<string>;
  /**
   * Report a background subscription failure so it can surface in `varStatus()`. A provider
   * must never throw out of a background stream; it reports here instead. `terminal: true`
   * means the provider has given up reconnecting for those scopes.
   */
  onSubscriptionError?(error: Error, info: { terminal: boolean; scopes: string[] }): void;
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
  /** Push-subscription state for the scope's source, when a subscribing transport is in use. */
  subscription?: VarSubscriptionStatus;
}

/**
 * Full observability report keyed by the FULL var key minus the `var.` prefix
 * (e.g. `agentic.lanes.vinci`) — the same keying the Go SDK's `VarStatus()` uses and the
 * same keying every `values` payload uses on the wire.
 */
export type VarStatusReport = Record<string, VarScopeStatus>;

/** Watch callback fired only after a validated commit. */
export type VarWatchCallback = (
  next: ResolvedVarSnapshot,
  prev: ResolvedVarSnapshot | undefined,
) => void;
