# CNOS Runtime Variables (`var.*`) — Design Draft

Status: draft v3, pre-implementation. Aligned with the runtime-configuration requirement handoff (2026-07-18, Boss/Kyive; initial consumer Kyive Agentic / Vinci).

Naming: the handoff recommends `run.*`; CNOS uses **`var.*`** (settled earlier — `run.*` collides conceptually with host runtime namespaces like `process.*`). No aliases (`dyn.*` etc.), per the handoff's own no-alias rule. Everything else in the handoff maps onto `var.*`.

## Problem

CNOS has two value tiers today:

- `value.*` — authored deployment/bootstrap config, schema-checked, resolved at build time. Static per resolution pass.
- `secret.*` — refs in repo, material hydrated from vaults at runtime.

Neither covers **mutable, non-secret operator policy** owned by a remote authority and changed while the process runs: allow/block lists, entitlements, kill switches, execution-lane policies. Consuming services must not build their own config databases, polling clients, push endpoints, or delivery protocols — CNOS is the single runtime-configuration plane.

`var.*` is the third tier:

```text
value.*  = deployment/bootstrap configuration (static, safe path)
secret.* = secret material / references
var.*    = mutable, non-secret runtime configuration (this design)
```

CNOS must stay generic: no consumer business semantics (no Vinci/Agentic/Boss/Kyive vocabulary) in core.

## Architecture: three planes

```text
[Authoring/control plane]      [Distribution]                [Consumer SDK]
 cnos CLI / Ops UI / API  ──▶  versioned var store        ──▶ pull / subscribe (rpc, http, ws, sse)
 create → validate →           (revisions, generations,       snapshot cache, LKG, watch,
 activate / rollback            audit, scoped authz)           atomic swap, status
```

1. **Authoring/control plane** — CNOS-owned mutation model: immutable revisions, validation, atomic activation, optimistic concurrency, rollback, audit. Ops UI / Boss CLI act as clients of this plane, never as a second authority.
2. **Distribution** — the CNOS var server, shipped **library-first** and embeddable into an existing server process (see Server topology below); a thin standalone wrapper (`cnos var serve`) exists for deployments that want a dedicated central plane. Speaks the CNOS var protocol over pluggable transports, backed by pluggable storage.
3. **Consumer SDK** — per-runtime client owning fetch/watch, reconnect/resume, retry/backoff/jitter, snapshot caching, atomic replacement, last-known-good retention. Consuming services write zero transport or polling code.

## Settled decisions (carried from v2 + new)

1. **Transports pluggable**, priority **rpc → http → ws → sse** (`packages/var-*`, all shipped by CNOS, chosen per source in the manifest).
2. **Meta-namespace indirection.** Keys are `var.<group>.<rest>`; the manifest maps group → source. Read sites never name a remote; repointing a group is a manifest-only change.
3. **Source definitions are static config** on the normal safe path, projected read-only; adapters consume them at runtime.
4. **Payloads are key- or group-scoped, never whole-config snapshots.** Remotes touch only `var.*` keys in groups mapped to them. (The handoff's "snapshot" is the per-scope immutable document snapshot below — compatible.)
5. **Overlay precedence (new, from handoff).** Reading `var.<group>.<rest>` resolves: **① active, valid runtime revision → ② statically projected `value.<group>.<rest>` → ③ schema `default` if declared.** One stable call site; deactivating the runtime head cleanly restores the static value with no deployment. Apps never implement this precedence. `value.*` reads themselves are never remote-affected — the overlay exists only on the `var.*` read path.
6. **Fetch modes.** `prefetch` scopes resolve before `ready()`; `ondemand` scopes never block ready. Schema `required: true` = mandatory → fail fast (ready fails / typed refresh error / read throws); `default` = optional.
7. **Push is latching, not a server**, on the consumer side: core ingest + thin framework adapters mounted on the owning process (Node builtin http + Express; Go `net/http` first).
8. **`watch` is the single reaction construct.** After an accepted activation: nothing by default — next read sees it; watchers are opt-in. Pipeline: `push/pull → ingest → verify → validate → atomic commit → notify watchers`.
9. **Finalization**: `close()`.
10. **No secret payloads in `var.*`** (new, explicit). A runtime document may carry an opaque secret **reference**; the material continues through `secret.*`/vaults. Enforced at validation.

## Snapshot model (new)

The unit of runtime config is an immutable, validated **snapshot** per var key (a key's value may be a whole policy document). Snapshot metadata:

| Field | Meaning |
|-------|---------|
| `generation` | monotonic per scope; increases on every activation (including rollback) |
| `revision` | immutable content hash of the document |
| `schemaId` / `schemaVersion` | document schema identifier (e.g. `agentic-lanes/v1`) |
| `effectiveAt` | when the revision was activated |
| `observedAt` | when this SDK fetched/received it |
| `source` | `runtime` \| `static` \| `default` (which precedence tier produced the value) |
| `freshness` | `fresh` \| `stale` \| `expired` (driven by lease/ttl below) |
| `leaseExpiresAt?` | optional expiry/lease deadline |
| `lastKnownGood` | generation/revision of the retained LKG when current fetch state is degraded |

**Atomic activation:** concurrent readers observe either the complete old snapshot or the complete new one, never a mixture — store commits swap an immutable snapshot pointer. Batch pushes covering multiple keys commit atomically as one store transaction.

**Scope replacement (canonical, both SDKs).** A revision **replaces its scope**; it does not merge
into it. The store holds one entry per committed scope carrying that scope's whole batch, so:

- a key present in revision 1 and **absent** from revision 2 stops being served and falls back
  through the overlay to ② static / ③ default (watchers fire, because the effective value
  changed). Merging instead — which the Go store used to do — keeps serving a removed allowlist
  entry or a revoked policy flag forever, which is a security-relevant staleness bug, not a
  cosmetic one;
- a key is served by the **longest committed scope that is a dot-prefix of (or equal to) it**.
  A narrower scope fully shadows the range it owns: a key missing from the serving scope's batch
  does NOT fall through to a broader scope;
- an independently authored narrower scope (`g.a`) therefore SURVIVES a commit of the broader
  scope (`g`), and vice versa — replacement is per exact scope string;
- coverage is per KEY, not per scope: a key inside a committed scope whose revision does not
  carry it has no runtime tier at all (no `source: 'runtime'` snapshot, and an ondemand read
  still triggers a fetch).

**Fail-closed support:** during a transient outage the SDK serves last-known-good within the configured freshness/lease window; after expiry the snapshot reports `stale`/`expired`. CNOS surfaces the state; **the consumer decides the safety action** (e.g. cost-bearing execution fails closed). No consumer-specific enforcement in CNOS.

## Validation (new: whole-document)

Two schema layers:

- **Per-key rules** — existing `ConfigSpecRule` (`type`, `required`, `default`, `enum`, `pattern`) for scalar/simple vars.
- **Document schemas (new)** — a manifest `documents:` registry keyed by `schemaId/version`, declaring typed fields with `additionalProperties: false` semantics. A var key's schema rule binds it: `var.agentic.lanes.vinci: { document: agentic-lanes/v1, required: true }`.

Required behavior on every inbound revision (authoring-side before activation AND consumer-side at ingest):

- complete-document validation; unknown fields rejected; invalid types/ranges rejected; missing required fields rejected;
- an invalid revision **never** replaces last-known-good;
- rejection reason + rejected revision remain observable (status surface);
- validation completes before any watcher sees the revision;
- secret-material detection: documents may contain opaque `secret.*` refs, never inline secret values.

## Manifest (authoring surface)

```yaml
varSources:
  ops:                          # CNOS var server (control-plane-backed)
    transport: rpc
    url: cnos-vars.internal:443
    auth: { bearer: secret.ops.workload_token }
  user_service:                 # any service implementing the protocol directly
    transport: http
    url: https://config.run.app
    pollInterval: 30s

vars:
  agentic:
    source: ops
    mode: prefetch
    lease: 10m                  # freshness window; past it snapshots report stale/expired
  user:
    source: user_service
    mode: ondemand
    ttl: 60s

documents:
  agentic-lanes/v1:
    fields:
      enabled:            { type: boolean, required: true }
      model_target_ref:   { type: string, required: true }
      max_input_tokens:   { type: number }
      max_output_tokens:  { type: number }
      budgets:            { type: object }
    additionalProperties: false

schema:
  var.agentic.lanes.vinci: { document: agentic-lanes/v1, required: true }
  var.user.IN.coupon_allowed: { type: boolean, default: false }
```

Validation additions: every group references a declared source; every `var.*` schema rule belongs to a declared group; `required` + `default` together is an error; `document:` must reference a declared document schema.

## Runtime SDK surfaces

Follows existing constructs — no new idioms:

```ts
cnos.var('agentic.lanes.vinci')            // sync read via overlay precedence (runtime → value.* → default)
cnos('var.agentic.lanes.vinci')            // generic read, same path
cnos.require('var.agentic.lanes.vinci')    // mandatory read — throws if unresolved

cnos.varSnapshot('agentic.lanes.vinci')    // { value, generation, revision, schemaVersion, source,
                                           //   effectiveAt, observedAt, freshness, leaseExpiresAt, lastKnownGood }
                                           // cheap in-memory read, usable per request

await cnos.refreshVar('var.agentic.lanes.vinci')   // mirrors refreshSecret(key); honors ttl
await cnos.refreshVars()                           // mirrors refreshSecrets()

const stop = cnos.watch('var.agentic.lanes.vinci', (snap, prev) => { ... })  // fires only on validated activations
cnos.watch('var.user.*', cb)               // group/prefix watch

cnos.varStatus()                           // observability doc (below)
await cnos.close()                         // stop pollers, cancel subscriptions, release watchers
```

- Sync reads never block on the network; unfetched `ondemand` optional keys serve the static/default tier and trigger a background fetch.
- Watch callbacks receive **snapshots** (value + metadata) so consumers can apply fail-closed policy; a callback error never rolls back the store — the snapshot is already active (consumer-side apply failures are the consumer's concern, reported by the consumer).
- Go mirrors: `cnos.Var(key)`, `cnos.VarSnapshot(key)` + `snapshot.Decode(&policy)` typed decode, `cnos.RefreshVar(ctx, key)`, `cnos.Watch(key, fn)`, `cnos.VarStatus()`, `cnos.Close()`.
- Restart recovery: on boot, `prefetch` scopes re-fetch the active runtime head — a restart never loses the runtime head (it re-converges from the source of truth, not local disk).

## Control plane (new)

### Server topology: library-first, never a sidecar

CNOS never runs its own process alongside a service. The server side follows the same latching philosophy as the consumer receiver. Three roles:

1. **Pure consumer** — embeds the SDK as a client only. No inbound surface, no ports; the optional push receiver latches onto the service's existing server.
2. **Authority service (embedded)** — a service that already runs a server and owns config for others embeds the var-server *library* into its existing listener:
   - Go/gRPC: `cnosvar.RegisterVarServer(grpcServer, store)` — registers `cnos.var.v1` on the same `grpc.Server` (gRPC multiplexes services on one port).
   - Node/HTTP: `app.use('/cnos/vars', varServer(store))` — mounts protocol routes on the existing express/http server.
   The host brings a pluggable storage backend and gets the full activation model (revisions, generations, optimistic concurrency, audit) as library behavior. This is the `user_service → https://config.run.app` case: an existing server implementing the protocol, with the heavy lifting shipped by CNOS.
3. **Dedicated central plane (standalone)** — `cnos var serve`: a thin wrapper (the same library + `main()` + config file) deployed as its own service when a dedicated authority is wanted (operator policy; Ops UI / Boss CLI as clients). One server implementation total — standalone vs embedded is a packaging choice, not an architecture fork.

A service can hold two roles at once: consume `var.ops.*` from the central plane while acting as the authority for `var.<its-group>.*` toward downstream clients — expressed by the existing group → source mapping.

### Storage & activation model

Pluggable **var store** behind the var server: `varServer(store)`. Persistence is a property of the chosen store, not a server mode — one server implementation, two guarantee classes:

- **`memoryStore()` (ephemeral, default for embedded/latched authorities).** Head and history live in memory. Validation, generations, and optimistic concurrency are enforced while alive; on authority restart the runtime head is absent and consumers safely fall back to precedence tiers ②/③ (static/default) — the overlay makes ephemeral mode degrade cleanly by design.
- **Persistent stores (`fileStore(path)` first; GCS/Firestore/SQL backends as separate packages, mirroring vault providers).** An **append-only, event-sourced log book**: `revision-created`, `activated`, `deactivated`, `rejected` events, each recording actor, reason, timestamps, previous/new revision, and the document schema id/version active at write time (self-describing — replay validates against the schema that governed the write). Content-addressed revision documents ride alongside.

Derived properties of the persistent log:

- **current head** = last activation event; **full state** = fold of the log;
- **restart/resume**: the authority resumes from the last persisted activation on boot — never from fallback;
- **replay & time travel**: reconstruct state at any generation (`cnos var replay --to-generation N`), diff generations, full `history`;
- **append-only forever**: rollback activates a prior revision as a *new* generation; the log never rewrites;
- **compaction**: periodic snapshot markers keep replay bounded without truncating auditability (design detail for the store interface);
- **safe to store and ship**: the log carries `var.*` documents and opaque secret *refs* only — never secret material.

Rejected-revision records (reason + revision) and full mutation audit are events in the same log, observable via status/history surfaces.

### Mutation model

Operations (exposed via `cnos var` CLI + control API; Ops UI / Boss CLI are clients):

- `create` — store an immutable revision (validated against its document schema at creation);
- `validate` — dry-run validation of a candidate revision;
- `activate` — atomically point the scope head at a revision, allocating the next generation; requires `--expect-generation` (optimistic concurrency: stale expected-generation → **revision conflict error**, never overwrite);
- `deactivate` — remove the runtime head; consumers cleanly fall back to static `value.*` / defaults (precedence tier ②/③), no deployment;
- `rollback` — activate a prior revision **as a new generation** (history is append-only);
- idempotent mutation requests (client-supplied idempotency key);
- `audit` / `history` — inspect activation log and rejections;
- `replay --to-generation N` — reconstruct/diff state at any past generation (persistent stores only).

### Security & scoping

- **Reads**: workload identity; a service may read only the var groups assigned to it (scope claims on the read token; server enforces group-level least privilege).
- **Writes**: operator/admin authorization, scoped by business/brand, environment (maps to CNOS profile), and component (maps to workspace/group).
- Cross-scope reads and writes are denied at the server.
- Full mutation audit: actor, reason, previous revision, new revision.
- Wire/auth material via `secret.*` refs, as everywhere in CNOS.

## Observability

`cnos.varStatus()` (SDK, per scope) and `cnos var status` (CLI against server):

```jsonc
{
  "agentic.lanes.vinci": {
    "desiredGeneration": 14,        // server head (when known)
    "appliedGeneration": 14,        // what this process serves
    "revision": "sha256:…",
    "source": "runtime",
    "snapshotAge": 42,
    "freshness": "fresh",
    "lastRefreshAt": "…",
    "lastError": null,
    "lastRejected": { "revision": "sha256:…", "reason": "unknown field 'budgets2'", "at": "…" }
  }
}
```

Logs and status never expose secret material or entire sensitive documents (masking rules follow the existing secret-masking model; documents in `sensitive: true` groups are summarized by revision hash only).

## Distribution protocol

CNOS-defined, per transport; the reference var server implements all, and any service can implement it directly. The wire shapes below are **canonical across every SDK** (TypeScript server/SDK, Go SDK) — reconciled in W4.5 and pinned by shared fixtures under `fixtures/var-cross-sdk/` asserted parse-equivalent in both toolchains.

### `values` keying convention (uniform)

In **every** pull response and push payload, `values` is ALWAYS a JSON object keyed by the **full var key minus the `var.` prefix** — e.g. `{ "agentic.lanes.vinci": { …document… } }` — for BOTH key-scoped and group-scoped batches. There is no scope-relative or bare-document form on the wire.

**Scope kind is syntactically decidable** from the prefix-stripped scope string: a **group** is a single segment with no dot (`agentic`, `user`); a **key** always contains a dot (`agentic.lanes.vinci`). Shared helpers encode this (`isVarGroupScope`/`isVarKeyScope` in core; `groupFromVarKey` + the same dot rule in Go).

- **Key-scoped** GET wraps the as-authored head document under its own key: `values = { "<scope>": doc }`.
- **Group-scoped** GET passes the head document through unchanged. The var server validates at revision-create time that a group document is an object whose every top-level key starts with `"<group>."` (else rejected with issue code `var.group-scope-shape`); key-scoped revisions keep validating against their bound document schema.
- SDK ingest extracts uniformly: each `values` entry (keyed by full stripped key) becomes that key's snapshot.

### Transports

- **rpc (gRPC, `cnos.var.v1`, first)**: `Pull(scope, knownRevision) → SnapshotBatch`; `Subscribe(scopes) → stream SnapshotBatch`. Proto shipped in `packages/var-rpc` (see the rpc subsection below).
- **http**: `GET {url}/cnos/vars?key=|group=` → `200 { generation, revision, schemaId?, effectiveAt, values }`, `304` on `If-None-Match: <revision>`, `404 {code:"no-head"}` → overlay fallback.
- **ws / sse**: subscribe scopes on connect; server emits snapshot-batch events.
- **Consumer-side receiver (latching)**: optional inbound push for http-only environments — `POST /cnos/vars/:scope` handled by the mounted adapter → same ingest path.

**Polling is capability-keyed, never transport-name-keyed (canonical, identical in both SDKs).** A source is polled only when its provider does **not** implement `subscribe`. A pull-only provider (http today) with a `pollInterval` polls; a subscribe-capable provider (rpc) relies on its subscription and is never polled, even when `pollInterval` is declared — the setting is ignored and warned once per source. Polling behind a subscription would double-fetch and, worse, silently paper over a TERMINAL subscription, which is the exact failure the terminal state exists to advertise.

### rpc (gRPC) transport

The canonical proto lives at **`packages/var-rpc/proto/cnos/var/v1/var.proto`** — a single
source of truth referenced by both sides (TypeScript loads it at runtime with
`@grpc/proto-loader`; the Go submodule encodes the same messages directly).

```proto
service VarService {
  rpc Pull(PullRequest) returns (SnapshotBatch);
  rpc Subscribe(SubscribeRequest) returns (stream SnapshotBatch);
}
```

- **Scope** is the prefix-stripped scope string, so the same syntactic dot rule decides its
  kind: `PullRequest.scope` / `SubscribeRequest.scopes` carry a group (no dot) or a key (dot).
- **`values_json`** is `bytes` carrying the SAME canonical JSON object as the http `values`
  field — keyed by the full var key minus `var.`. This deliberately reuses the reconciled JSON
  convention and the existing document validators rather than duplicating schemas in proto.
- **Semantics map 1:1 onto http**: `not_modified` ≙ `304` (known revision still current, keep
  cache, `values_json` empty) · `no_head` ≙ `404 {code:"no-head"}` (no active runtime head →
  overlay fallback to tiers ②/③). Both SDKs raise the same `NotModified` / `NoHead` conditions
  the http transport does, so the ingest path is transport-agnostic.
- **Auth**: gRPC metadata `authorization: Bearer <token>`, resolved from the source's
  `secret.*` ref at call time — the metadata twin of the http `Authorization` header, checked
  by the same `authorize({kind:'read', scope, token})` hook the http server uses.
- **Subscribe** is fed by the var-server engine's commit seam (`engine.onCommit`), which fires
  after every accepted activation/deactivation; the server pushes the new canonical head batch
  (or a `no_head` batch on deactivation) to every subscriber whose scope matches. Reconnect
  uses the same capped backoff+jitter policy as the pollers, and clients re-pull with known
  revisions on reconnect to converge.
- **Subscribe is self-synchronizing** (pre-release protocol behavior change; no shim). An
  accepted `Subscribe` **always emits an initial event** — for each requested scope, its
  current head batch, or a `no_head` batch when the scope has no active head — **before** any
  live commit. Convergence on (re)connect therefore comes from the stream alone, including the
  deactivation case, which has no other path to converge for a source that runs no poller. Two
  mechanisms make this race-free:
  - The commit listener is registered **synchronously at handler entry**, before the
    `await authorize(...)`. Registering it after the await left a sub-millisecond window in
    which a commit reached neither the stream (no hook yet) nor the client's resync pull
    (already issued) — a lost activation, or worse a lost deactivation.
  - Commits arriving during that authorization window are **buffered** and flushed in commit
    order ahead of the initial state, deduplicated against it by revision so a client never
    sees the same revision twice in a row. The flush, the initial state and the switch to the
    live path run in one synchronous block, and `emitCommit` is itself synchronous, so nothing
    interleaves. A **refused** subscription discards the buffer, writes nothing, and still
    terminates with `UNAUTHENTICATED`.

  The client-side reconnect resync pull below is retained as belt-and-braces (it covers a
  server predating this change); in the happy path it is redundant, and the store's
  content-addressed revision gate suppresses the duplicate watcher fire.
- **`cnos var serve --rpc <port>`** serves the rpc transport alongside the http plane, sharing
  one store and one engine so http-admin activations reach rpc subscribers.
- **Wire pinning**: the Go module hand-writes the protobuf encoding (protoc is not a build
  prerequisite), so byte-level fixtures under `fixtures/var-cross-sdk/rpc/` assert Node and Go
  encode/decode identically in both directions.

### Receiver contract (both SDKs, identical)

- **Payload**: `{ revision?, generation?, schemaId?, effectiveAt?, values }` with `values` per the keying convention above.
- **Signature**: `x-cnos-signature: sha256=<hex hmac-sha256 of the raw body>` — the `sha256=` prefix is REQUIRED; compared in constant time. A bearer token (`Authorization: Bearer <token>`) compared against the source `verify` secret is the alternative.
- **Response codes**: `204` accepted · `401` verification failure · `422` validation-rejected batch (last-known-good retained) · `400` malformed.
- **Defaults when absent**: `revision` = `sha256:` of the canonical JSON (sorted keys, compact, no HTML escaping) of `values`; `generation` = current unix millis. Implemented identically in both SDKs.

### On-demand scoping

Both SDKs fetch on-demand at **group** scope, with one deduped in-flight fetch per group (a first sync read of any key in the group serves the static/default tier immediately and triggers a single background group fetch).

### Freshness transitions (canonical)

Age is measured from the snapshot's `observedAt`. Static/default tiers never expire.

| ttl | lease | age condition | freshness |
|-----|-------|---------------|-----------|
| set | set | `age ≤ ttl` | `fresh` |
| set | set | `ttl < age ≤ lease` | `stale` |
| set | set | `age > lease` | `expired` |
| set | — | `age ≤ ttl` | `fresh` |
| set | — | `age > ttl` | `stale` (never expires) |
| — | set | `age ≤ lease` | `fresh` |
| — | set | `age > lease` | `expired` (no stale tier) |

### Reconnect resync (canonical, both SDKs)

Reconnect/resume with backoff+jitter; **on every successful (re)connect of a subscription stream
the SDK re-pulls each subscribed scope with its known revision** and routes the result through the
normal ingest path — including `no-head` → scope removal. All SDK-owned.

This is not an optimization. The server forwards **future** commits only, so an activation *or a
deactivation* that happens during an outage or a backoff window is otherwise lost permanently, and
a subscribe-capable source runs no poller to converge with. A missed deactivation means serving
withdrawn policy forever.

- **Ordering barrier**: the SDK subscribes FIRST, then pulls. A commit racing the pull therefore
  arrives on the (already open) stream instead of falling between the two, and the scope's
  operation epoch decides which of the two wins (see mixed pull/push ordering below).
- **First connect**: a scope is skipped only when a head was already prefetched for it. When in
  doubt, pull — a redundant pull is far cheaper than a lost deactivation. Every RE-connect always
  pulls every subscribed scope.
- **Transport seam**: the provider reports the connect through
  `VarSourceProviderContext.onSubscriptionConnected(scopes, { reconnect })` /
  `VarProviderContext.OnSubscriptionConnected(scopes, reconnect)`; the pull itself is issued by
  the SDK, so every transport gets the same convergence for free.

### Mixed pull/push ordering (canonical, both SDKs)

Two DIFFERENT rules, deliberately:

1. **Push vs push — last write wins.** An out-of-order push is applied as it arrives; the store
   commits by revision and watchers dedupe on it.
2. **Pull vs push — the push wins.** Every scope carries a monotonic **operation epoch**, bumped
   on every authoritative application (an accepted ingest, and a `no-head` even when it removes
   nothing). A pull captures the epoch before issuing its request and applies its result only if
   the epoch is unchanged on completion; otherwise the result is dropped as superseded.

Without rule 2 a stale pull response could reintroduce a head the authority had already
deactivated, and a delayed `no-head` could clear a newer pushed activation — permanently, for an
ondemand or rpc source with no poller to correct it.

### Watcher dispatch ordering (canonical, both SDKs)

State mutation is atomic AND dispatch is sequenced. Each commit freezes an immutable notification
event (the watcher registry as of the commit, plus the `prev`/`next` snapshots captured around the
mutation) and appends it to a queue in commit order. One event is delivered to EVERY watcher
before the next event starts. A reactivation triggered from inside a deactivation callback
therefore cannot make the watchers visited later in the same pass skip the fallback transition,
and two goroutines committing concurrently cannot interleave an older activation behind a newer
deactivation. Unsubscribing from inside a callback still suppresses a not-yet-delivered fire.

### Deactivation (`no-head`) semantics — canonical, both SDKs, every transport

A `no-head` is a **definitive answer from the authority**: "this scope has no active head". It is
not a failure. On receiving one — from an http `404 {code:"no-head"}` pull, an rpc `no_head` pull,
or an rpc `no_head` **push** — the SDK performs an atomic **scope removal**: the runtime-tier
entries for that scope and everything nested beneath it are dropped in a single swap (the same
immutable-swap / CAS discipline as ingest, so no reader ever observes a half-removed scope), and
reads fall through the overlay to ② static `value.<group>.<rest>` and ③ the schema `default`. This
is what makes acceptance #15 true end to end without a redeploy.

- **Watchers fire**, because the effective value changed. They receive the snapshot the key now
  resolves to, whose `source` is `static` or `default`.
- **Removal is idempotent**: a `no-head` for a scope with nothing applied is a silent no-op that
  wakes no watcher.
- **A transport error is NOT a `no-head`** and must never clear anything: an unreachable remote
  retains last-known-good, which is precisely what the lease/freshness model describes.
- **`varStatus()` for a deactivated scope** reports the tier that took over (`source: 'static' |
  'default'`, or `'none'` when the key resolves nowhere), `appliedGeneration: 0`, and no
  `revision` / `desiredGeneration` — a removed head never masquerades as still applied.
- **Required keys**: a deactivation does not by itself fail anything at refresh time. A required
  key left unresolvable stays fail-fast *lazily* (at read/`require` time). Prefetch startup is the
  exception — see below.

### Required-key enforcement on prefetch (canonical, both SDKs)

A **required** key in a `prefetch` group must resolve from *some* tier by the end of startup, or
`ready()` / `StartVars` fails. The check runs after **every** prefetch outcome — ingested,
`not-modified`, `no-head`, validation-`rejected`, a thrown transport error, **and a missing
transport module**. A **missing transport module** (no provider registered for the declared
transport) is a deployment gap that is *warned*; it is non-fatal only while every required key of
the group still resolves through the static/default tiers. It never waives required enforcement —
treating it as a blanket carve-out let Node report a ready runtime that failed only later, at read
time, where Go rejected `StartVars`. `refreshVar` on a required key rejects on a transport failure
or a validation-`rejected` revision, but not on a `no-head`.

### Startup / close lifecycle (canonical, both SDKs)

`close()` is coordinated with the shared startup attempt, not just with the resources that already
exist when it is called:

- runtime cancellation cancels the in-flight prefetch (Go runs prefetch on a ctx derived from both
  the caller's ctx and the runtime's; Node's providers are closed and the attempt re-checked);
- startup re-checks the closed state after every await/wait and before creating ANY long-lived
  resource (provider, poller, subscription);
- `close()` does not return until the attempt has stopped, so the provider/timer/subscription sets
  it cleans are complete;
- a startup that observes a closed runtime FAILS — `ErrVarClosed` (Go) / a thrown `closed` error
  (Node) — rather than reporting a ready runtime with nothing running behind it;
- a FAILED attempt rolls back everything it created, **including the providers it constructed**:
  they are closed and evicted so a retry recreates them through the factory instead of reusing a
  possibly poisoned instance.

### Projection `schema` block

`toServerProjection` emits an optional var-only `schema` block keyed by the **full var key** (e.g. `var.agentic.lanes.vinci`), carrying `{ document?, required?, type?, enum?, pattern?, default? }`. `default` is emitted ONLY when declared in the manifest (JSON absence = not declared; the Go SDK tracks presence via `HasDefault`). Only keys under `var.` are included; nothing else in the projection changes. Both SDKs consume it when bootstrapped from a projection so ingest validation and required/default enforcement work without the authoring manifest.

## Provider contract (core)

```ts
interface VarSourceProvider {
  pull(scope: VarScope, knownRevision?: string): Promise<VarSnapshotBatch>;
  // A push transport reports EVERY authoritative outcome, not just head batches: a `no-head`
  // event is a deactivation the SDK turns into a runtime-tier removal. Mirrors the Go
  // `VarBatchResult.Status` (`VarPullOK` / `VarPullNoHead`) carried through one callback.
  subscribe?(scopes: VarScope[], onEvent: (e: VarPushEvent) => void): () => void;
  close(): Promise<void>;
}
type VarPushEvent = { kind: 'batch' | 'no-head'; scope?: string; batch?: VarSnapshotBatch };
type VarScope = { key?: string; group?: string };
type VarSourceProviderFactory = (def: ProjectedVarSourceDefinition, ctx: { resolveSecret(ref: string): Promise<string> }) => VarSourceProvider;
```

Registered like secret vault factories (`varSourceProviders` create option + `registerVarSourceProviders()`); official modules self-register via the batteries-included package.

## Package layout

| Surface | Where |
|---------|-------|
| Types, manifest, normalization, validation (incl. document schemas), projection, snapshot/store/ingest/watch core | `packages/core` |
| Singleton wiring, receiver adapters (`@kitsy/cnos/express` etc.) | `packages/cnos` |
| Transport modules | `packages/var-rpc`, `var-http`, `var-ws`, `var-sse` |
| Var server library (embeddable) + standalone wrapper + storage backends | `packages/var-server` (embeddable handlers/gRPC registration; `cnos var serve` wraps it) + `var-store-file` (+ `var-store-gcs`, … later) |
| Test double | `packages/var-testkit` (mirrors `vault-testkit`) |
| CLI | `cnos var create|validate|activate|deactivate|rollback|status|history`; `cnos build server` emits `varSources`/`vars`/document schemas; `cnos list var`; `inspect` provenance |
| Go SDK | `packages/go`: `Var/VarSnapshot/Decode/RefreshVar/Watch/VarStatus/Close`, rpc + http clients, `net/http` receiver |

## Phasing

1. **Node authoring + core model** — types, manifest (`varSources`/`vars`/`documents`), normalization, validation, overlay precedence in resolution, ServerProjection blocks, CLI build emit, snapshot/store core, docs/ADR.
2. **Control plane v1** — `cnos var` mutation commands, file-backed store, reference var server (rpc + http), authz hooks, audit log.
3. **Node runtime SDK** — live store + ingest + watch + snapshot/status APIs, rpc module, http module (+ receiver adapters), LKG/lease behavior, `close()`.
4. **Go runtime SDK** — full consumer contract (first production consumer: Vinci via Kyive Agentic), rpc + http clients, `net/http` receiver, typed `Decode`.
5. Later: ws/sse modules, more storage backends, more framework adapters, remaining 6 runtimes.

## Requirement traceability (acceptance tests → design)

| # | Test | Covered by |
|---|------|-----------|
| 1 | Static fallback with no runtime revision | overlay precedence tiers ②/③ — including after a deactivation, not only before a first activation |
| 2 | Activation updates running consumer without restart | subscribe/poll → ingest → atomic commit → watch |
| 3 | Readers see only complete snapshots | immutable snapshot pointer swap; batch = one transaction |
| 4 | Invalid/unknown-field revisions rejected | document schema validation, `additionalProperties: false` |
| 5 | Rejection keeps last-known-good | invalid revision never replaces LKG (validate-before-commit) |
| 6 | Monotonic generations | activation log allocates per-scope monotonic generation |
| 7 | Stale expected-generation writes conflict | `activate --expect-generation` optimistic concurrency |
| 8 | Rollback works, audited | rollback = new generation + audit record |
| 9 | Restart recovers active runtime head | consumer: prefetch re-fetch on boot; authority: persistent store resumes from last activation in the log |
| 10 | Network loss retains LKG within window | lease/freshness window; SDK serves LKG |
| 11 | Expired state visible to consumer | `freshness: expired` on snapshot + status |
| 12 | Cross-scope reads/writes denied | server-enforced scope claims (business/env/component) |
| 13 | No secrets in payloads/logs/status | validation-time detection; masking; refs-only rule |
| 14 | No service-specific delivery code | SDK owns transport entirely; providers pluggable |
| 15 | static → runtime → static without deployment | activate/deactivate flips precedence tier only; deactivation is an atomic runtime-tier **removal** driven by `no-head` (pull or push), covered end to end for http and rpc in both SDKs |

## Non-goals (inherited)

No budgeting/usage/ledger/counter state, no model routing, no consumer authorization logic, no business vocabulary in core, no secret values in `var.*`, no per-service polling daemons, no browser/public exposure of `var.*` in v1.

## Implementation deltas (doc vs shipped code)

Recorded during the docs pass; the code is authoritative where these differ from prose above.

1. **Ondemand fetches are group-scoped.** An on-demand read never pulls a bare key — it pulls the whole group, deduped to one in-flight fetch per group. Both SDKs behave this way.
2. **Transport availability is staged**, not simultaneous: `http` and `rpc` (gRPC, `cnos.var.v1`) have real providers; `ws` and `sse` are accepted by the manifest schema but have no provider yet.
3. **`varStatus()` is two distinct shapes** — the consumer SDK's per-scope status vs. the server's own scope status. They share field names where they overlap but are not the same type.
4. **Receiver route is a convention, not a contract.** Both SDKs only require the scope to be the last URL path segment; `POST /cnos/vars/:scope` is the recommended mount, not an enforced one.
5. **rpc registration is explicit.** `@kitsy/cnos` does not depend on `@kitsy/cnos-var-rpc`; pass `varSourceProviders: [rpcVarSourceProvider]` to opt in, so gRPC is never forced on consumers. Likewise the Go rpc client lives in the `packages/go/varrpc` submodule — the root Go module stays stdlib-only.
6. **`lastKnownGood` is the DISPLACED revision.** It names the last revision that was successfully validated and served while fresh — stamped at commit time from the outgoing snapshot, absent on a scope's first commit, and independent of the current freshness. It is a diagnostic/rollback pointer, never the value being served. Identical in both SDKs since W5d.
7. **`varStatus()` is keyed by the prefix-stripped full var key** (`agentic.lanes.vinci`), not by scope/group — the same keying every wire `values` payload uses. Per-scope metadata (errors, rejections, subscription state) is inherited by every key that scope serves. Identical in both SDKs since W5d.
8. **Watcher dispatch is idempotent.** A commit reproducing a key's existing `(revision, generation)` wakes no watcher; a same-revision/new-generation commit does. A watcher registered from inside a callback is not visited by the notify pass already running. Identical in both SDKs since W5d.
9. **Absent lease ≠ zero lease.** An omitted `lease` never expires; a declared `lease: 0` expires immediately. Presence is tracked from the manifest duration string (Go) / `parseDuration` returning `undefined` vs `0` (Node), mirroring `default`-presence tracking in schema rules.
10. **Receiver verification fails closed and is presence-based.** A source with no `verify` secret cannot accept pushes (`401`); when the signature header is present the signature alone decides (a wrong signature is `401` even with a valid bearer), otherwise the bearer decides. Inbound bodies are capped (1 MiB default, configurable) with `413` past the cap. Identical in both SDKs since W5d.
11. **The Node SDK's `generation` range is `0..2^53-1`.** A batch outside it is rejected (`var.generation-range`) rather than committed with a rounded value; the rpc provider raises the same failure while it still holds the exact wire text. Go carries a native int64 and has no limit — so an authority serving both SDKs must stay below 2^53. The wire representation is unchanged (JSON number / decimal string).
12. **The var-server `authorize` hook has three kinds.** `read` (data plane), `audit` (`GET {base}/admin/*` — the append-only log) and `mutate`. Mutation bodies are parsed before authorization so `scope` is populated for writes too.

13. **A `no-head` CLEARS the applied runtime snapshot** (round-2 review). Earlier builds only recorded a refresh, so a deactivated revision kept being served — and the rpc client dropped `no_head` pushes entirely, which was unrecoverable for an rpc source since it runs no poller. Both SDKs now route every `no-head`, pull or push, through an atomic scope removal. See the deactivation section above.
14. **Polling is capability-keyed.** Go previously polled any source declaring a `pollInterval`, so an rpc source both subscribed and polled. Both SDKs now poll only providers that do not implement `subscribe`, and warn once when a subscribe-capable source declares a `pollInterval`.
15. **Node startup is transactional and Go shares its in-flight attempt.** A failed Node start rolls back the timers/subscriptions it created, so the retry permitted by the round-1 latch fix cannot duplicate them. Concurrent Go `StartVars` callers block on one shared attempt and receive the same result instead of the second caller seeing a `started` flag and returning `nil` early; the attempt is cleared on failure (retryable) and kept on success. `StartVars(ctx)` now runs prefetch on the CALLER's ctx (pollers/subscriptions keep the runtime-lifetime ctx, since they must outlive it).
16. **Node `varStatus()` reports the serving fallback tier.** With no runtime head it names `static`/`default` (matching the Go SDK) rather than always `none`; `none` now means "resolves from no tier at all".
17. **Round-3 deltas (all cross-SDK parity fixes).**
   a. **Reconnect resync is real.** Neither SDK re-pulled on reconnect despite the ADR promising
      it; a single activation or deactivation during an outage was lost permanently. Both now
      resync via `onSubscriptionConnected` / `OnSubscriptionConnected` (subscribe-then-pull).
   b. **A revision REPLACES its scope.** The Go store merged per-key updates, so a key dropped by
      a new revision kept being served. Go now stores one entry per scope, like Node.
   c. **Coverage is per key.** Node reported `source: 'runtime', value: undefined` for a key
      inside a committed scope that the revision did not carry; it now has no runtime tier at
      all, matching Go's store-miss semantics (`hasRuntimeScope` is presence-based too).
   d. **Mixed pull/push ordering** is a distinct contract from out-of-order-push last-write-wins;
      see the section above.
   e. **Watcher dispatch is queued in commit order** in both SDKs.
   f. **`close()` is coordinated with the in-flight startup** in both SDKs; a start on a closed
      runtime fails.
   g. **A missing transport module no longer waives required enforcement** (Node).
   h. **A Node start rollback also closes the providers the attempt created.**
   i. **Go records refresh metadata on every valid `no-head`**, including one that removes
      nothing — it used to keep reporting a stale transport error where Node reported recovery.
   j. **The Go receiver commits at the pushed SCOPE**, not at the collapsed group, matching Node.
18. **Subscribe is self-synchronizing** (round-3 follow-up; protocol behavior change, pre-release,
    no compatibility shim). Round-3 delta 17a fixed reconnect resync from the CLIENT side, but the
    server still registered its `engine.onCommit` listener only after `await authorize(...)`: a
    commit landing between the Subscribe request arriving and that registration completing was
    delivered by neither the stream nor the resync pull. The server now registers the listener
    synchronously and buffers commits across the authorization window, and **an accepted Subscribe
    always emits an initial event** (current head, or `no_head`) per requested scope. See the rpc
    transport section. Consequence for every client: **a subscribe now always produces at least one
    event**; both SDKs already treat it as an ordinary batch/`no_head`, and the content-addressed
    revision gate in each store suppresses a duplicate watcher fire when it repeats a known revision.

19. **Semantics are fixture-pinned too, as of the parity suite.** `fixtures/var-cross-sdk/` pins the
    WIRE; `fixtures/var-parity/` pins the observable SEMANTICS. It is one declarative scenario set
    (JSON) executed by a thin interpreter in each SDK — `packages/cnos/test/var-parity.test.ts` and
    `packages/go/var_parity_test.go` — against an in-process fake source, asserting only public
    results (value, tier, freshness, start/refresh outcome KIND, `varStatus()` fields, watcher fire
    sequences). It covers the axes every one of the 16 review findings lived on: startup outcome ×
    required × mode × head/no-head/not-modified/transport-error/missing-module × fallback tier,
    deactivation via pull and push, scope replacement and per-key coverage, mixed pull/push
    ordering, watcher dispatch (including a reentrant commit), the freshness table, `varStatus()`
    shape per state, and the close/startup lifecycle. Both runners are part of the ordinary suites.
    One product fix came out of it: **Go's `varStatus()` now reports `source: "none"`** for a key
    that resolves from no tier at all (it reported `default`), matching Node and this document's
    deactivation section. Four behaviors where the SDKs still differ and the ADR does not decide
    are recorded IN the spec as divergent expectations (each side pinned to what it actually does,
    reported but not failed) — see Open decisions 7-10.

## Open decisions

1. ~~Server topology~~ — **resolved**: library-first embeddable var-server, standalone `cnos var serve` as a thin wrapper (see Server topology section). Never a sidecar process. Storage-direct SDK reads (polling GCS/Firestore directly, no server) may come later as a simple mode.
2. ~~Document schema syntax~~ — **resolved**: CNOS-native `documents:` field map. Validation code is shared with `ConfigSpecRule` and no validator dependency was taken.
3. **Where the control plane's authz identity comes from** (workload identity federation vs static tokens via secret refs) — likely deployment-specific config on `var-server`, pluggable like vault auth. The v1 `authorize` hook is the seam.
4. ~~Lease vs ttl naming/merge~~ — **resolved**: two fields with distinct semantics (`ttl` = ondemand staleness bound, `lease` = fail-closed freshness window). See the freshness transition table.
5. ~~Subscribe give-up policy~~ — **resolved (W5d)**: gRPC `UNAUTHENTICATED` / `PERMISSION_DENIED` are **terminal** (never reconnected — the same credentials can only be refused again); transport failures retry with capped exponential backoff + jitter but are **bounded** by a consecutive-failure cap (8), after which the subscription also becomes terminal. Every failure is reported through the provider's `onError` option and the SDK's `onSubscriptionError` seam, surfacing as `subscription: { state: 'failed' | 'retrying' | 'active' }` in `varStatus()` / `VarStatus()`. Nothing throws out of a background stream and nothing fails silently. A terminal subscription deliberately does **not** fall back to periodic pulls: the same credentials would be refused by `Pull`, and a silent poll loop would hide the very failure the terminal state exists to advertise — consumers alert on `failed` and may call `refreshVar()` explicitly. Server-side, an auth-rejected `Subscribe` now ends the stream with `call.emit('error', status)`; `call.destroy(status)` tore the call down locally without ever putting a status on the wire, which is what left Node clients hanging silently.
6. **Node/Go divergence — startup error KIND on a transport failure.** A required prefetch key with
   no fallback and an unreachable source fails startup in both SDKs (that part is canonical), but
   Node rethrows the raw transport error while Go wraps it as `ErrVarRequired`. A caller
   distinguishing "the remote is down" from "this key is unresolvable" gets different answers.
   Pinned in `fixtures/var-parity/scenarios/startup.json` as DIVERGENCE-1. **Needs a decision: does
   the required-enforcement error type belong to the cause or to the rule?**
7. **Node/Go divergence — `refreshVars()` failure reporting.** Node warns and resolves for every
   group failure; Go returns the error (required-group failures preferred over optional ones).
   A consumer cannot write one contract against both. Pinned as DIVERGENCE-2 in
   `scenarios/deactivation.json`. Related: Node's `refreshVars()` covers PREFETCH groups only while
   Go covers every group with a source. **Needs a decision on both halves.**
8. **Node/Go divergence — `varStatus().freshness` for a key that resolves from no tier.** Node
   reports the sentinel `none`; Go's `Freshness` enum has no such member and reports `fresh`.
   (`source` is now `none` in both — see delta 19.) Pinned as DIVERGENCE-3 in `scenarios/status.json`.
   **Needs a decision: widen the Go enum, or narrow Node to the three-state type?**
9. **Node/Go divergence — `close()` cannot cancel an in-flight prefetch in Node.** Go derives the
   prefetch ctx from the runtime ctx, so `close()` aborts the pull and returns promptly. The Node
   provider contract (`pull(scope, knownRevision): Promise<VarSnapshotBatch>`) carries **no
   cancellation signal at all**, and `VarManager.close()` awaits the start attempt before closing
   providers — so a Node `close()` blocks until the in-flight pull settles on its own (up to the
   transport's own timeout, 30s for the http provider). Both honor "close() does not return until
   the attempt has stopped"; the lifecycle section's parenthetical "Node's providers are closed and
   the attempt re-checked" describes an intent the shipped code does not implement. Pinned as
   DIVERGENCE-4 in `scenarios/close.json`. **Needs a decision: add an `AbortSignal`/cancel seam to
   the TS provider contract (a public API change), or accept and document the shutdown latency?**
10. **`publish-go.yml` does not tag `packages/go/varrpc/v*`** — the submodule layout is compatible, but the tag line must be added before it is consumable from pkg.go.dev.
