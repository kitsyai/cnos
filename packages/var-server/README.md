# @kitsy/cnos-var-server

Embeddable CNOS **var (`var.*`) control-plane server**: immutable revisions, monotonic
generations, atomic activation, optimistic concurrency, rollback, an append-only audit log,
and pluggable storage. Library-first — never a sidecar. Standalone `cnos var serve` is a
thin wrapper over the same library.

## Roles

- **Embedded authority.** Mount the handler on your existing Node server:
  ```ts
  import { fileStore, varServer } from '@kitsy/cnos-var-server';
  const store = fileStore('./.cnos/var-log.jsonl');
  // http.createServer:
  http.createServer(varServer(store, { documents })).listen(8080);
  // or express-style (no express dependency here):
  app.use('/cnos/vars', varServer(store, { base: '/cnos/vars', documents }));
  ```
- **Standalone central plane.** `serveVarServer(store, { port })` (backs `cnos var serve`).

## Stores

| Store | Persistence | Use |
|-------|-------------|-----|
| `memoryStore()` | ephemeral, empty on restart | embedded/latched authorities; overlay degrades cleanly to static/default |
| `fileStore(path)` | append-only JSONL log book | durable head + full audit; restart recovery; replay/time-travel |

Reads (`store.head` / `status` / `revision`) are synchronous and lock-free: they observe a
single immutable per-scope state snapshot, so a concurrent append is never partially
visible. `append` persists first, then swaps the snapshot in one synchronous assignment.

## HTTP route table

Base defaults to `/cnos/vars`. Mutations live under `{base}/admin/*`.

| Method | Path | Body / Query | Success | Errors |
|--------|------|--------------|---------|--------|
| GET | `{base}?key=<scope>` or `?group=<scope>` | — | `200 { generation, revision, schemaId?, effectiveAt, values }` + `ETag: <revision>`; `304` when `If-None-Match` equals the current revision | `404 no-head` when no active head; `400 bad-request` |
| POST | `{base}/admin/revisions` | `{ scope, document, schemaId?, schemaVersion?, actor?, reason?, idempotencyKey? }` | `201 { scope, revision, generation, created }` (`200` when the content-addressed revision already existed) | `422 revision-invalid { issues }` |
| POST | `{base}/admin/validate` | `{ document, schemaId?, scope? }` | `200 { valid, issues }` | — |
| POST | `{base}/admin/activate` | `{ scope, revision, expectedGeneration, actor?, reason?, idempotencyKey? }` | `200 { scope, generation, revision, effectiveAt }` | `409 revision-conflict { expectedGeneration, currentGeneration }`; `404 not-found` (unknown revision) |
| POST | `{base}/admin/deactivate` | `{ scope, expectedGeneration, actor?, reason?, idempotencyKey? }` | `200 { scope, generation, active: false }` | `409 revision-conflict` |
| POST | `{base}/admin/rollback` | `{ scope, expectedGeneration, toRevision? \| toGeneration?, actor?, reason? }` | `200 { scope, generation, revision, effectiveAt }` | `409 revision-conflict`; `404 not-found` |
| GET | `{base}/admin/status?scope=<scope>` | — | `200 { scope, active, generation, revision?, source, lastRejected? }` | `400 bad-request` |
| GET | `{base}/admin/history?scope=<scope>` | — | `200 { scope, events: VarEvent[] }` | `400 bad-request` |
| GET | `{base}/admin/replay?scope=<scope>&toGeneration=<n>` | — | `200 <ScopeHead>` (persistent stores only) | `404 not-found`; `400 store-unsupported` (ephemeral store) |

**ETag / 304.** The `ETag` value is the content-addressed revision (`sha256:...`). A consumer
sends `If-None-Match: <revision>`; an unchanged head returns `304` with no body.

Authorization: every request runs through `options.authorize({ kind, scope, token })`
(bearer token parsed from `Authorization: Bearer …`). Default is allow-all with a one-time
stderr warning; `staticBearerAuthorize(tokens)` is provided for dev/CI. Denied → `403`.

## Event-log format (`fileStore`)

One JSON object per line (JSONL), appended forever. Event kinds:
`revision-created`, `activated`, `deactivated`, `rejected`.

```jsonc
{ "kind": "revision-created", "scope": "agentic.lanes.vinci", "revision": "sha256:…",
  "document": { "enabled": true, "model_target_ref": "secret.ops.model" },
  "schemaId": "agentic-lanes/v1", "actor": "ops", "timestamp": "2026-07-20T…Z" }
{ "kind": "activated", "scope": "agentic.lanes.vinci", "revision": "sha256:…",
  "generation": 1, "previousGeneration": 0, "actor": "ops", "reason": "enable vinci",
  "timestamp": "2026-07-20T…Z" }
{ "kind": "rejected", "scope": "agentic.lanes.vinci",
  "rejectionReason": "document.unknown-field: Unknown field 'budgets2' …",
  "timestamp": "2026-07-20T…Z" }
```

- **Current head** = fold of the log (last activation not followed by a deactivation).
- **Generations** are monotonic per scope; every `activated`/`deactivated` allocates the
  next one. Rollback re-activates a prior revision as a *new* generation — the log is never
  rewritten.
- **Restart recovery**: the store replays the log on construction and resumes from the last
  activation — never from fallback.
- **No secret material**: documents carry `var.*` values and opaque `secret.*` **ref
  strings** only. Nothing in the log is ever a resolved secret.

## Idempotency

Mutations accept a client `idempotencyKey`. A replayed request returns the original result
without appending a second event. The map is rebuilt from the log on restart, so it survives
across process boundaries for persistent stores.
