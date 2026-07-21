# Runtime Variables (`var.*`) Reference

Full design/ADR: `docs/cnos-runtime-vars.md`. Published docs: `packages/docs/docs/guides/runtime-variables.mdx` and `packages/docs/docs/guides/var-server.mdx`. This file is the agent-facing map — verify anything load-bearing against the code, not the design doc (the design doc predates implementation and has drifted in places; see the end of this file).

## Concept

Third value tier alongside `value.*` (static, build-time) and `secret.*` (vault-backed refs):

```text
value.*  = deployment/bootstrap configuration (static, safe path)
secret.* = secret material / references
var.*    = mutable, non-secret runtime configuration owned by a remote authority
```

Keys are `var.<group>.<rest>`. The manifest maps `<group>` to a declared `varSources` entry — read sites never name a remote; repointing a group is a manifest-only change.

**Overlay precedence** on every `var.*` read: ① active, valid runtime revision → ② statically projected `value.<group>.<rest>` → ③ schema `default` if declared → `undefined`. `value.*` reads are never affected by this overlay.

**Fetch modes**: `prefetch` (resolves before `ready()`; required-and-unresolvable fails fast) vs `ondemand` (never blocks `ready()`; first read triggers one deduped background fetch of the whole group).

**Freshness**: `fresh` / `stale` / `expired`, driven by a group's `ttl` (staleness) and `lease` (fail-closed window). CNOS reports freshness; it never enforces a safety policy — the consumer decides what an `expired` var means for its own request path.

**Deactivation** (`no-head`) is an atomic **scope removal**, not a no-op. A definitive "no active head" from the authority — http `404 {code:"no-head"}`, rpc `no_head` pull, or rpc `no_head` **push** — drops the runtime tier for the scope and everything nested beneath it (single swap; no torn state), fires watchers with the static/default snapshot that took over, and clears the head's generation/revision from `varStatus()`. A transport error is NOT a no-head and retains last-known-good. Removal is idempotent. `LiveVarStore.removeScope` / `varStore.removeScope` + `applyNoHead` in both SDKs.

**Scope replacement.** A revision REPLACES its scope, it never merges into it. The store holds one entry per committed scope carrying that scope's whole batch. A key present in revision 1 and absent from revision 2 stops being served and falls through to ② static / ③ default (watchers fire) — merging kept serving removed allowlist entries and revoked flags. A key is served by the LONGEST committed scope that is a dot-prefix of it, and a missing key does NOT fall through to a broader scope, so an independently authored narrower scope (`g.a`) survives a commit of `g`. Coverage is per KEY, not per scope. `LiveVarStore` scope map / `varStore.commit(scope, group, updates)`.

**Reconnect resync.** On every successful (re)connect of a subscription stream the SDK re-pulls each subscribed scope with its known revision through the normal pull path (`no-head` → scope removal included). The server forwards FUTURE commits only, so without this a mutation made during an outage is lost permanently — fatal for a deactivation on an rpc source, which runs no poller. Ordering barrier: SUBSCRIBE first, then pull. First connect skips scopes that already have an applied head; every reconnect pulls everything. Seam: `VarSourceProviderContext.onSubscriptionConnected` / `VarProviderContext.OnSubscriptionConnected`.

**Self-synchronizing Subscribe (rpc server).** An accepted `Subscribe` ALWAYS emits an initial event per requested scope — the current head batch, or `no_head` when there is none — before any live commit, so a (re)connecting client converges from the stream ALONE (the deactivation case has no other path). The commit listener is registered SYNCHRONOUSLY at handler entry, before `await authorize(...)`; commits arriving during the authorization window are buffered and flushed in commit order ahead of the initial state, deduplicated against it by revision. A refused subscription discards the buffer, writes nothing, and still terminates with `UNAUTHENTICATED`. The client-side resync pull above is retained as belt-and-braces (covers a pre-change server); the store's content-addressed revision gate (`varStore.enqueueNotification` / Go `var_runtime.go`) suppresses the duplicate watcher fire. `attachVarRpc` in `packages/var-rpc/src/server.ts`.

**Mixed pull/push ordering** is a SEPARATE contract from out-of-order-push last-write-wins. Each scope carries a monotonic operation epoch, bumped on every authoritative application (accepted ingest, and a `no-head` even when it removes nothing). A push always applies; a PULL applies only if the epoch is unchanged between issuing the request and completing it, otherwise it is dropped as superseded. `LiveVarStore.scopeEpoch` / `varRuntime.epochs` + `ingestGated`/`applyNoHeadGated`.

**Watcher dispatch ordering.** Each commit freezes an immutable notification event (watcher registry as of the commit + `prev`/`next` captured around the mutation) and queues it in commit order; one event is delivered to EVERY watcher before the next starts. Reentrancy-safe (a reactivation from inside a deactivation callback is queued, not interleaved) and concurrency-safe in Go. `enqueueNotification`/`drainNotifications` in both SDKs.

**Startup vs close.** `close()` cancels the in-flight prefetch and WAITS for the startup attempt before cleaning; startup re-checks the closed state after every await and before creating any long-lived resource; a start on a closed runtime FAILS (`ErrVarClosed` / thrown). A failed attempt rolls back its timers, subscriptions AND providers (closed and evicted, so a retry recreates through the factory).

**Polling is capability-keyed, never transport-name-keyed**: a source is polled only when its provider does not implement `subscribe`. A `pollInterval` on a subscribe-capable source (rpc) is ignored and warned once — polling behind a subscription would mask a terminal one.

**Snapshots** are immutable per-scope objects (`{ value, generation, revision, schemaId?, effectiveAt, observedAt, source, freshness, leaseExpiresAt?, lastKnownGood? }`). Batch commits are atomic (validate-before-swap) — a reader never observes a partial update.

**Watch** is the single reaction construct: fires only after a validated, committed activation. A callback error is caught/logged; it never rolls back the store.

**Documents**: a `documents:` registry (keyed by `schemaId/version`) declares whole-document schemas (`fields`, `additionalProperties`). A `schema` rule binds a var key to one via `document: <schemaId>`. Two validation layers exist: scalar per-key rules (`type`/`enum`/`pattern`) via `validateScalar`, and whole-document validation via `validateDocumentValue` — both live in `packages/core/src/validation/validateVars.ts` and are reused by the var-server engine.

## Key modules map

| Concern | Where |
|---|---|
| Types (`VarSourceDefinition`, `VarGroupDefinition`, `DocumentSchemaDefinition`, `VarSnapshot`, `VarSourceProvider`, etc.) | `packages/core/src/types/var.ts` |
| Manifest normalization (`varSources`/`vars`/`documents`) | `packages/core/src/manifest/normalizeVars.ts` |
| Manifest validation (`var.*` rules — unknown-source, unknown-group, required-and-default, unknown-document, auth-not-secret-ref, public-exposure) + whole-document validation | `packages/core/src/validation/validateVars.ts` |
| Overlay precedence + `var.` key helpers (`isVarKey`, `isVarGroupScope`/`isVarKeyScope`, `toCanonicalVarValues`, `toValueOverlayKey`, `resolveVarOverlay`) | `packages/core/src/runtime/readVar.ts` |
| In-memory live store: per-scope snapshots, atomic ingest, atomic `removeScope` (deactivation), freshness calc, watch dispatch, status | `packages/core/src/runtime/varStore.ts` (`LiveVarStore`) |
| Orchestrator-facing coordinator: provider construction, transactional `start()` (rollback on failure), prefetch/ondemand lifecycle, capability-keyed pollers (`If-None-Match`), refresh, receiver + push-event ingest routing (`applyNoHead`) | `packages/core/src/runtime/varManager.ts` (`VarManager`) |
| Core runtime wiring (`createRuntime`): `var()`, `varSnapshot()`, `varStatus()`, `refreshVar()`/`refreshVars()`, `watch()`, `close()`, internal `__startVars`/`__ingestVar`/`__varSource`/`__resolveVarSecret` hooks used by the receiver | `packages/core/src/orchestrator/runtime.ts` |
| `ServerProjection` var blocks (`varSources`, `vars`, `documents`, `schema` keyed by full var key, `default` emitted only when declared) | `packages/core/src/runtime/toServerProjection.ts` |
| Derived-value integration: `var.*` refs are valid (unlike `secret.*`/`public.*`) but make the derivation runtime-dependent (never cached) | `packages/core/src/derive/validate.ts`, `packages/core/src/derive/runtime.ts` |
| New error types (`CnosVarRequiredError`, `CnosVarNoHeadError`, `CnosVarNotModifiedError`) | `packages/core/src/errors.ts` |
| Control-plane engine: `createRevision`/`validateRevision`/`activate`/`deactivate`/`rollback`/`status`/`history`/`replay`, per-scope serialized locking, optimistic concurrency | `packages/var-server/src/engine.ts` (`VarEngine`) |
| Pluggable `VarStore` contract + `memoryStore()` + `fileStore(path)` (append-only JSONL, replay, restart resume) | `packages/var-server/src/types.ts`, `memoryStore.ts`, `fileStore.ts`, `baseStore.ts` |
| Embeddable HTTP handler (`varServer(store, opts)`) + standalone wrapper (`serveVarServer`, backs `cnos var serve`) | `packages/var-server/src/httpServer.ts`, `serve.ts` |
| Authorization hook (`allowAllWithWarning`, `staticBearerAuthorize`); `VarAuthKind` is `read` \| `audit` (admin GETs) \| `mutate`, and mutation bodies are parsed BEFORE authorize so `scope` is populated for writes | `packages/var-server/src/authorize.ts` |
| Control-plane error types (`CnosVarConflictError`, `CnosVarValidationError`, `CnosVarNotFoundError`, `CnosVarStoreError`) — note: separate from `packages/core/src/errors.ts` | `packages/var-server/src/errors.ts` |
| http transport `VarSourceProvider` (pull with ETag/`If-None-Match`, `404 no-head` → `CnosVarNoHeadError`, `304` → `CnosVarNotModifiedError`) | `packages/var-http/src/index.ts` |
| Test doubles: ephemeral `startTestVarServer()`, transport-free `createInMemoryVarSource()` | `packages/var-testkit/src/index.ts` |
| Singleton runtime var API (`cnos.var`, `cnos.varSnapshot`, `cnos.varStatus`, `cnos.refreshVar(s)`, `cnos.watch`, `cnos.close`, `registerVarSourceProviders`) | `packages/cnos/src/runtime/index.ts`, `packages/cnos/src/runtime/varSupport.ts` |
| Node push receiver (latching, mount on your own http/express server) | `packages/cnos/src/varReceiver.ts` |
| Default var source provider registration (http auto-registered) | `packages/cnos/src/defaultVarSourceProviders.ts`, `packages/cnos/src/plugin/var-http.ts` |
| CLI command + control surface (local `--store` / remote `--server`) | `packages/cli/src/commands/var.ts`, `packages/cli/src/services/varControl.ts` |
| CLI help surface (`var`, `var create/validate/activate/deactivate/rollback/status/history/replay/serve`) | `packages/cli/src/cli/helpRegistry.ts` |
| Go SDK: `Var`/`VarSnapshot`+`Decode`/`RefreshVar`/`RefreshVars`/`Watch`/`VarStatus`/`VarReceiver`/`Close` | `packages/go/var_runtime.go`, `var_client.go`, `var_receiver.go`, `var_snapshot.go`, `var_projection.go`, `var_store.go`, `var_validate.go` |
| Cross-SDK wire fixtures (source of truth for wire shapes) | `fixtures/var-cross-sdk/` (asserted parse-equivalent by `packages/core/test/cross-sdk-wire.test.ts` and `packages/go/var_crosssdk_test.go`) |
| Cross-SDK SEMANTIC parity spec (source of truth for observable lifecycle behavior) | `fixtures/var-parity/` (one declarative scenario set executed by `packages/cnos/test/var-parity.test.ts` and `packages/go/var_parity_test.go`) |

**Changing any observable `var.*` behavior means changing BOTH.** The wire fixtures catch shape
drift; the parity spec catches semantic drift (startup outcome, tier + freshness of a read,
deactivation, scope replacement, pull/push ordering, watcher dispatch, `varStatus()` fields,
close). Add a scenario there rather than a hand-written twin test — see
`fixtures/var-parity/README.md`, including the divergence policy for behavior the ADR does not
settle (recorded with both observed sides, never reconciled by weakening an assertion).

## Wire conventions (canonical — verify against `fixtures/var-cross-sdk/` before writing any example)

- **Uniform values keying.** In every pull response, push payload, and http read response, `values` is keyed by the **full var key minus the `var.` prefix** — for BOTH key- and group-scoped batches. A key-scoped batch wraps the document: `{ "<scope>": doc }`. A group-scoped batch passes the document through as-is (already keyed by full stripped keys); the var-server enforces that shape at revision-create/validate time (`var.group-scope-shape`).
- **Scope-kind rule** (shared by TS and Go, syntactically decidable): a scope with no dot is a GROUP (`agentic`); a scope with a dot is a KEY (`agentic.lanes.vinci`). See `isVarGroupScope`/`isVarKeyScope` in `readVar.ts`.
- **Receiver verification codes**: `204` accepted, `401` verification failed OR the source declares no `verify` secret (fail closed), `413` body over the cap (1 MiB default, configurable), `422` validation-rejected (last-known-good kept, body carries `issues`), `400` malformed request (missing scope, missing `values`, bad JSON), `404` receiver mounted for an undeclared source, `503` var runtime not ready, `405` non-POST.
- **Signature header**: `x-cnos-signature: sha256=<hex hmac-sha256 of the raw request body>` — the `sha256=` prefix is REQUIRED and part of the comparison. Scheme selection is PRESENCE-based: header present → the signature decides (a wrong signature is `401` even alongside a valid bearer); header absent → `Authorization: Bearer <token>` is compared against the same `verify` secret. Identical scheme in the Node (`varReceiver.ts`) and Go (`var_receiver.go`) receivers.
- **Status keying**: `varStatus()` / `VarStatus()` are keyed by the prefix-stripped FULL var key, like every `values` payload. Per-scope metadata is inherited by every key the scope serves.
- **`lastKnownGood`**: the revision the current commit DISPLACED (last validated + served while fresh). Absent on a scope's first commit; independent of freshness.
- **Generation range**: int64 on the wire; the Node SDK rejects anything outside `0..Number.MAX_SAFE_INTEGER` (`var.generation-range`) instead of rounding. Go is exact.
- **Lease presence**: absent lease = never expires; declared `lease: 0` = expires immediately. Go tracks presence via the non-empty duration string; Node via `parseDuration` returning `undefined` vs `0`.
- **Push events**: a subscribing provider's callback receives a `VarPushEvent` (`{ kind: 'batch' | 'no-head', scope?, batch? }`), not a bare batch — the Go twin is `VarBatchResult.Status` (`VarPullOK` / `VarPullNoHead`). `no-head` carries its `scope` (the only thing naming what to clear) and is asserted present by `fixtures/var-cross-sdk/rpc/snapshot-batch-no-head.bin` in both wire tests.
- **Required prefetch keys** are checked against the whole overlay after EVERY prefetch outcome (ingested / not-modified / no-head / rejected / thrown error / MISSING TRANSPORT MODULE): unresolvable ⇒ `ready()` / `StartVars` fails. A missing transport module is warned and is non-fatal ONLY while every required key still resolves from static/default — it is not a blanket carve-out (round-3 blocker 3). `refreshVar` on a required key rejects on a transport failure or a validation-`rejected` revision, but NOT on a no-head.
- **Watcher dispatch is idempotent**: an exact `(revision, generation)` replay wakes nobody; a watcher registered inside a callback is not visited by the event committed before it existed; unsubscribing from inside a callback suppresses a not-yet-delivered fire. Events are dispatched in commit order, one fully before the next.
- **Default revision/generation on push**: when a push payload omits `revision`/`generation`, both SDKs derive `revision = sha256:` of the canonical JSON (sorted keys, compact) of `values`, and `generation = current unix millis` — asserted byte-identical across SDKs by `fixtures/var-cross-sdk/default-revision.json`.
- **Projection `schema` block**: `default` is emitted in JSON only when actually declared in the manifest (absence = "not declared", not "declared as undefined") — this is required for required/default enforcement to round-trip identically across SDKs. See `ProjectedVarKeyRule` in `types/var.ts` and the Go `VarKeyRule` custom (Un)MarshalJSON in `var_projection.go`.
- **var-server HTTP route table**: canonical copy lives in `packages/var-server/README.md` and is reproduced in `packages/docs/docs/guides/var-server.mdx`. If you change the protocol, update the README, the guide, and the two cross-SDK tests together.

## Safety rules

- `secret.*` and any `sensitive: true` namespace rule from `CLAUDE.md`/`namespaces.md` applies equally to `var.*`: **no secret material** in var documents, the append-only log, `varStatus()`/`cnos var status`, or `cnos var history`. A document may carry an opaque `secret.*` **reference** string only.
- `var.*` must never reach `public.*`, `toPublicEnv()`, or browser projections. Enforced at manifest validation (`var.public-exposure` in `validateVars.ts`) and structurally — there is no var-to-public promotion path.
- `varSource.auth`/`varSource.verify` values must be `secret.*` refs (`var.auth-not-secret-ref`).
- Derived expressions **may** reference `var.*` (it is not in the forbidden-ref set alongside `secret.*`/`public.*`), but doing so makes the derivation runtime-dependent by definition (Critical Rule 9): **never cached**, re-evaluated on every read. See `packages/core/src/derive/validate.ts` and the `VAR_NAMESPACE` handling in `packages/core/src/derive/runtime.ts`.
- Sensitive-document summarization in status/history is by revision hash only (mirrors existing secret-masking conventions) — do not print full document bodies for groups you don't control the sensitivity of.

## Package layout (current, W1-W4.5)

`packages/core` (types/manifest/validation/overlay/store/manager/projection), `packages/var-server` (embeddable control-plane engine + stores + HTTP handler + standalone `serve`), `packages/var-http` (http transport provider), `packages/var-testkit` (test doubles, mirrors `vault-testkit`), `packages/cnos` (singleton wiring + Node receiver + default provider registration), `packages/cli` (`cnos var ...`), `packages/go` (Go consumer SDK: client, receiver, store, snapshot, validate, projection, runtime).

`packages/var-rpc` (gRPC transport, `cnos.var.v1`) landed in W5a; `packages/go/varrpc` is its Go twin (a separate module so the root Go module stays stdlib-only).

**Startup (canonical, identical in both SDKs).** See the close/startup rule above for round-3 lifecycle coordination. Node memoizes the in-flight start promise; Go shares one `varStartAttempt` (concurrent `StartVars` callers block on its done channel and get the same result). The attempt is cleared on failure (retryable) and kept on success. Node's `VarManager.start()` is transactional — a failed attempt rolls back the timers/subscriptions it created so a retry cannot duplicate them. Go's `StartVars(ctx)` runs prefetch on the CALLER's ctx; pollers/subscriptions keep the runtime-lifetime ctx so they outlive it.

**Subscribe failure policy (canonical, identical in both SDKs).** gRPC `UNAUTHENTICATED`/`PERMISSION_DENIED` are terminal — never reconnected. Transport failures retry with capped exponential backoff + jitter, bounded by a consecutive-failure cap (`MAX_CONSECUTIVE_SUBSCRIBE_FAILURES` / `MaxConsecutiveSubscribeFailures` = 8), after which the subscription is terminal too. Failures are reported via the provider `onError` option and the SDK seam (`VarSourceProviderContext.onSubscriptionError` / `VarProviderContext.OnSubscriptionError`), surfacing as `subscription: { state }` in `varStatus()`/`VarStatus()`. A terminal subscription does NOT fall back to polling. Server-side, terminate a rejected `Subscribe` with `call.emit('error', status)` — `call.destroy(status)` never reaches the client.

## Design-doc vs implementation discrepancies (report, do not silently "correct" the design doc)

The design doc (`docs/cnos-runtime-vars.md`) is largely accurate post-implementation, but a few points drifted or were resolved more narrowly than drafted:

1. **Ondemand fetch granularity.** The design doc doesn't specify fetch granularity for `ondemand` reads. The implementation always fetches the **whole group** on first miss (one deduped in-flight fetch per group), never a bare single key — see `VarManager.maybeTriggerOndemand`. Document this as the actual behavior, not "the key is fetched."
2. **`ws`/`sse` transports and `rpc` are not implemented.** The design doc lists `rpc → http → ws → sse` as the transport priority with all "shipped by CNOS." As of W1-W4.5, only `http` has a working provider (`packages/var-http`); `rpc` is in progress in a sibling worktree; `ws`/`sse` are schema-only (accepted by manifest validation, no provider module exists). Docs should say this plainly rather than imply all four exist today.
3. **`varStatus()` field semantics differ slightly by layer.** The design doc's single example status object mixes the consumer-SDK shape (`desiredGeneration`/`appliedGeneration`/`snapshotAge`) with what is actually two distinct shapes in code: the consumer `VarScopeStatus` (core `types/var.ts`) and the server's own `ScopeStatus` (`var-server/src/types.ts`, `{ scope, active, generation, revision?, source, lastRejected? }`, no `desiredGeneration`/`snapshotAge`/`freshness`). Both are documented separately in the new guide to avoid implying they're the same object.
4. **Lease vs ttl "open decision" is resolved in code, not just decided in prose.** The design doc lists "lease vs ttl naming/merge" as an open decision. The implementation ships both as separate fields with distinct semantics (`ttl` = staleness threshold, `lease` = fail-closed/expiry threshold) — see `LiveVarStore.freshnessFor` in `varStore.ts` and the mirrored Go `computeFreshness`. Worth updating the design doc's "Open decisions" section to mark this resolved, but that edit was left to whoever owns the ADR next (out of scope for this docs-only pass beyond noting it here).
5. **Receiver route/URL shape is a convention, not enforced.** The design doc implies a fixed `POST /cnos/vars/:scope` receiver path. In code, `varReceiver()` (Node) and `VarReceiver()` (Go) only require the target scope to be the **last path segment** of whatever URL you mount them at — the base path is entirely up to the host. Docs should present `/cnos/vars/push/:scope` as an example convention, not a fixed contract.
