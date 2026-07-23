# Review Handover — `var.*` Runtime Variables (`main...var-runtime`)

**Branch:** `var-runtime` (23 commits ahead of `main`, clean tree, nothing pushed)
**Size:** 153 files, +28,208 / −43
**Review status:** rounds 1–3 complete — 2, 6 and 8 findings, all valid, all fixed. Since round 3:
the rpc Subscribe stream is self-synchronizing (`4890a06`), a 44-scenario cross-SDK semantic
parity suite pins lifecycle behavior in CI (`3f70b1c`), and its four surfaced divergences are
resolved by architect ruling (`32e09e4`). **This is the round-4 pass.**
**Target release:** 1.18.0 (minor — purely additive)
**Design/ADR:** `docs/cnos-runtime-vars.md` · **Agent context:** `.agents/context/runtime-vars.md`

## What this feature is

A third configuration tier alongside the existing two:

```
value.*  = authored deployment config, resolved at build time (static)
secret.* = refs in repo, material hydrated from vaults at runtime
var.*    = mutable, non-secret operator policy, live from a remote authority  ← NEW
```

`var.*` covers config that changes *while the process runs* — allow/block lists, entitlements,
kill switches, execution-lane policy. CNOS owns fetch, watch, reconnect, caching, atomic
replacement and last-known-good, so consuming services write zero transport or polling code.

Driven by a formal requirement handoff (2026-07-18); first production consumer is a Go service.
Naming note: the handoff proposed `run.*`; we use `var.*` (avoids collision with host runtime
namespaces like `process.*`). No aliases.

## Commits in review order

| Commit | Phase | Contents |
|---|---|---|
| `3a292ef` | R1 | Round-1 fixes: ondemand no longer gates Ready; failed starts no longer latch |
| `c5e6e0b` | R2 | Round-2 fixes: deactivation clears the runtime tier; required-check parity; shared in-flight startup; ctx; poll capability; transactional startup |
| `22f287c` | W1 | Core authoring: types, manifest `varSources`/`vars`/`documents`, normalization, validation, overlay precedence, projection emit |
| `43c451c` | W2 | Control plane: `packages/var-server` (engine + stores + HTTP), `var-testkit`, `cnos var` CLI |
| `a328671` | W4 | Node SDK: live store, `VarManager`, `var-http` provider, receiver, singleton API, derive Rule 9 |
| `1e58a7c` | W3 | Go SDK: store, overlay, snapshot/Decode, watch, receiver, poller |
| `ebebf36` | W4.5 | Cross-SDK reconciliation — canonical wire shapes + shared fixtures |
| `e564ccb` | W5c | Published docs, `.agents` context, ARCHITECTURE/namespaces updates |
| `04907fe` | W5a | rpc (gRPC) transport: proto, `var-rpc`, Go `varrpc` submodule, Subscribe |
| `4d48e05` | W5b | 160 hardening tests; **found 10 defects** |
| `1c562f7` | — | ADR updated with implementation deltas |
| `7c6e85c` | W5d | **Fixes for all 10 defects** |
| `78a8d10` | — | Watcher-gate fix (11th defect, found during verification) |
| `be28ae7` | W6 | Release prep: publish config + Go submodule pin automation |

Reviewing W1 → W2 → W4 → W3 → W4.5 in order is the intended narrative; W5b/W5d are best read as a
pair (the pinned test and its fix).

## Shared SEMANTIC parity suite (post-round-3)

Every round found Node and Go disagreeing on lifecycle, and the wire fixtures structurally cannot
catch that. `fixtures/var-parity/` now pins the semantics the same way `fixtures/var-cross-sdk/`
pins the wire: **one declarative JSON scenario set, executed by a thin interpreter in each SDK**
(`packages/cnos/test/var-parity.test.ts`, `packages/go/var_parity_test.go`), asserting only public
observable results. 44 scenarios across startup, read, deactivation, scope replacement, ordering,
watcher dispatch, freshness, `varStatus()` and close. Both run in the ordinary suites.

Outcomes:

- **1 fix**: Go's `varStatus()` reported `source: "default"` for a key that resolves from NO tier;
  the ADR names that state `none` (as Node always did). Fixed (`VarSourceNone`).
- **4 divergences the ADR did not settle** — originally recorded in the spec with BOTH observed
  behaviors and escalated as ADR "Open decisions" 6-9. **All four are now RESOLVED and canonical**
  (architect ruling, this pass); each divergent expectation flipped to a single canonical
  assertion exercised identically by both runners:
  1. **Startup transport failure → required-kind error WITH cause.** Fails with
     `CnosVarRequiredError` / `ErrVarRequired` carrying the transport error as the cause (Node
     `error.cause`; Go a second `%w`). (Was: Node rethrew raw → kind `other`.)
  2. **`refreshVars()` attempts EVERY group (prefetch AND ondemand), never short-circuits, and
     rejects with an aggregate when any failed** (required-kind preferred). (Was: Node warned +
     resolved, prefetch-only.)
  3. **Nowhere-resolving `varStatus()` reports `none`/`none`** — Go's `Freshness` gained
     `FreshnessNone`. (Was: Go `fresh`.)
  4. **`close()` aborts an in-flight prefetch** — the TS `VarSourceProvider.pull` gained an
     `AbortSignal` option; Node `close()` now returns promptly and the startup caller gets
     `CnosVarClosedError`. (Was: no cancellation signal; Node blocked on the pull's own timeout.)
- **W9 reconnect qualification (architect ruling).** The initial current-head/`no_head` event that
  every accepted `Subscribe` emits is THE canonical convergence guarantee; the client-side resync
  pull is defensive redundancy, not independently mandatory — so the weaker Node isolation of that
  pull flagged under W9 is **acceptable**. The client pull and its tests are retained; no
  production test-only option was added. See the ADR rpc + reconnect-resync sections.
- **Non-vacuity**: originally proven by reverting one behavior per SDK (Go scope-replacement →
  merge; Node's round-3 blocker-3 early return). For this pass, the DECISION-4 abort wiring is
  revert-verified (removing it makes the Node close scenario fail), and DECISION-2's aggregate is
  revert-verified (reverting Node to warn+resolve makes the attempts-every-group scenario fail).

## Round 4 — findings and fixes (architect-conducted)

Round 4 was reviewed AND fixed by the architect directly (static review; the coordinator ran the
full verification afterward). Six findings, all in the surfaces the round-4 aiming section named:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | blocker | Node receiver accepted HMAC auth with an EMPTY resolved verify secret — anyone can compute a valid signature over an empty key. (Bearer branch and Go already rejected empty.) | Empty resolved verification secret → `401` before either scheme runs. |
| 2 | blocker | Multi-scope rpc Subscribe authorized only `scopes[0]` but delivered every requested scope — subscribe `["allowed","restricted"]`, pass on `allowed`, receive both. | Every unique scope authorized before anything is emitted; any denial rejects the whole stream. |
| 3 | high | BOTH SDKs collapsed rpc key-scoped batches to their group — a commit for `agentic.lanes.vinci` replaced scope `agentic`, dropping sibling runtime keys and defeating narrower-scope survival. (The receiver twin of this was fixed in round 3; the rpc ingest path had the same bug.) | `event.scope`/`batch.Scope` preserved as the committed scope; group derived only for config lookup. |
| 4 | high | Subscribe initial-sync read only `store.head(group)` while live delivery prefix-matches — a child-only activation yielded a bare group `no_head` that could clear valid child state, and child mutations during an outage were absent from the reconnect snapshot, contradicting the canonical initial-event convergence guarantee. | Initial sync enumerates every known matching scope (parent-first), emitting exact head/no-head per scope. |
| 5 | medium | Pre-authorization commit buffering was unbounded — a stalled authorize backend plus active commits consumed unbounded memory per connection. | Buffer capped at 1,024 events. |
| 6 | medium | Poll cadence observably diverged: Node per-group, Go per-source (one failing group backed off healthy siblings); Go's 30s "ceiling" was applied before positive jitter (real delays to 37.5s). | Canonical: per-GROUP scheduling, equal-jitter (`[next/2, next]`), ceiling as a hard cap after jitter, both SDKs. |
| — | ruling | The round-4 note asked for receiver-driven no-head deactivation but the receiver wire had no representation for it. | New receiver contract: `{ "noHead": true }` body deactivates the URL scope through the standard no-head path, both SDKs. |

Coordinator verification after the architect's pass: fixed three integration slips (an undefined
`torn` guard in the unary Pull handler → `call.cancelled`; a missing `strings` import in
`var_provider.go`; four Go reconnect tests whose outage windows were tuned to the old additive
jitter — equal jitter retries ~2× faster, so the bounded failure cap went terminal mid-outage;
fixed by raising `WithMaxSubscribeFailures` in those tests, preserving the canonical cadence).
Then: full `pnpm -r typecheck`/`test` green, both Go modules `build`/`vet`/`test` green
(uncached), **`RACE CHECK: PASS`**.

## Round 5 — findings and fixes (architect-conducted, final targeted round)

Round 5 targeted the round-4 self-synchronization/authorization surface, per the architect's
merge decision. Two findings, both fixed by the architect; the coordinator ran full verification
and revert-verified both behaviors.

1. **[High] Child-only initial sync exposed fallback blips.** The server always included the
   requested parent scope, so a subscription to `agentic` with only `agentic.child` active
   emitted `no_head("agentic")` then `head("agentic.child")` — the first event cascade-cleared
   the child and fired fallback watchers, the second restored it: a transient wrong value and
   duplicate transitions on EVERY reconnect with unchanged authoritative state. (A round-4 test
   pinned this sequence as expected — the ninth "test that asserted the wrong thing.") Fix: a
   **never-authored** parent with active descendants gets no synthetic `no_head`; an **explicit
   parent tombstone** (`generation > 0`) remains authoritative and cascading. Relatedly, the
   defensive reconnect pull now clears only the EXACT queried scope in both SDKs
   (`removeExactScope`), so a group-level no-head can never erase live child scopes.
2. **[Medium] Subscribe teardown guard lost in round-4 integration.** The `torn` check after the
   asynchronous authorization was dropped, so authorization succeeding after cleanup proceeded
   through flush/initialization on a torn stream. Fix: `torn` re-checked after every
   authorization await; a cancelled stream stops authorizing remaining scopes.

Coordinator verification: `pnpm -r typecheck`/`test` green, both Go modules `build`/`vet`/`test`
green uncached, **`RACE CHECK: PASS`**. Revert-verified: cascading the defensive cleanup fails
`TestVarNarrowerScopeSurvivesABroaderCommit` (Go); removing the parent-suppression fails both new
Node tests, including the full-manager no-fallback-watcher-event sequence.

Open item recorded by the architect for a future decision (not blocking): **descendant
authorization semantics** — whether authorizing a group intentionally grants every matching
child scope. Today it does (prefix matching); this is undocumented as a deliberate choice.

## W12 — hierarchical tombstone semantics (architect-conducted)

**RULING.** A parent tombstone (deactivating a parent var scope) clears every descendant scope
ACTIVE when the parent deactivation is committed. It is NOT a persistent ancestor mask. A later
child activation revives that child without parent reactivation; reactivating the parent does not
resurrect previously tombstoned children; a key-scoped tombstone affects only that key's own
subtree. Canonical histories: `activate(g.key); deactivate(g)` ⇒ both inactive;
`deactivate(g); activate(g.key)` ⇒ `g` inactive, `g.key` **ACTIVE**; `deactivate(g); activate(g)`
after children were tombstoned ⇒ those children **REMAIN inactive**.

This **replaces the round-5 persistent-mask behavior**, in which an explicit parent tombstone stood
as a cascading ancestor mask that suppressed later children. The tombstone is now a one-time subtree
mutation over the descendants active at commit time; each cleared scope carries its own tombstone
and is reconstructed exact-scope.

**Two contract changes, both deliberate and additive:**

1. **Wire** — `cnos.var.v1.SnapshotBatch` gained `bool exact_scope = 9`, meaningful only when
   `no_head = true`. `exact_scope=true` is reconstruction-only exact removal; false/omitted is
   cascading. This safe polarity preserves pre-W12 payload and Go zero-value behavior. Fixture
   `fixtures/var-cross-sdk/rpc/snapshot-batch-no-head-exact.bin` pins the explicit exact shape.
   SDK push events use `VarPushEvent.exactScope?` / `VarBatchResult.ExactScope`.
2. **Storage** — `VarEvent` retains optional `cascade?: string[]` on `deactivated` events, and
   `VarStore` now requires atomic `appendSubtreeDeactivation(event)` so custom stores cannot
   silently apply only the parent.
**Atomicity + serialization.** `VarEngine.deactivate` enumerates the descendants active at commit
time and clears the parent plus all of them in ONE appended log event (the `cascade` list on the
`deactivated` event) — a single JSONL line, so the subtree mutation is crash-atomic on the
`fileStore` (a torn multi-line write can never leave the parent inactive while a child stays
active). On fold/replay each listed descendant gets its own next monotonic generation and a
synthesized `deactivated` event carrying `cascadeParent`, actor, and reason. Every mutation
(create/activate/deactivate/rollback) now runs under a SINGLE engine-wide mutation lock (replacing
the former per-scope locks), so a subtree deactivation's enumerate→build→append is atomic against
every activation: a racing child activation linearizes either fully before the deactivation
(enumerated and cleared) or fully after it (queued behind the lock, commits fresh, survives) —
never interleaved. Reads stay lock-free.

**Delivery.** Live commits use the false/omitted cascading default; initial-sync and reconnect
RECONSTRUCTION no-heads use `exact_scope=true`, so a reconstruction never transiently
clears a descendant it is about to restore — the crux guarantee: no transient fallback watcher
event when the final reconstructed state contains an active child. http-pull `404` no-heads and the
http receiver `{noHead:true}` cannot enumerate descendants and so cascade client-side.

**Verification: both revert-verifications passed** — removing the engine's cascade enumeration fails
the parent-clears-active-child scenario, and collapsing reconstruction no-heads back to cascading
fails the no-transient-fallback-watcher scenario.

## Round 4 — where to aim (architect-directed)

The parity suite now mechanically pins 44 lifecycle scenarios, so re-finding what it covers is
low-value. Aim at the surfaces it documents as **inexpressible** (see
`fixtures/var-parity/README.md`), in priority order:

1. **rpc reconnect mechanics** — the initial current-head/`no_head` event on every accepted
   Subscribe is now the canonical convergence guarantee (client resync pull = defensive
   redundancy). Attack the guarantee itself: commit racing the authorize window, dedupe of the
   initial event against buffered flushes, reconnect storms, terminal-failure classification,
   and the interaction of the initial event with the store's epoch gating.
2. **Receiver behavior** — the push surface (`varReceiver` / `VarReceiver`) is outside the
   parity matrix. Signature verification order, body cap, scope-in-URL edge cases, concurrent
   pushes racing pulls, and receiver-driven deactivation (`no-head` push).
3. **Narrower-scope semantics** — the store's longest-dot-prefix serving rule and per-exact-scope
   replacement are parity-pinned only at group scope, because the consumer API only commits at
   group scope. The receiver and rpc paths CAN commit key-scoped batches: probe mixed
   key-scope/group-scope interleavings through those paths.
4. **Freshness boundaries and clock skew** — the suite tests window interiors only (no injectable
   clock on that path). Exact-boundary (`age == ttl`, `age == lease`) and negative-age behavior
   are asserted nowhere cross-SDK.
5. **Poller cadence** — backoff/jitter/interval behavior under flapping sources is untested
   beyond unit level.

Also standing: any test that cannot fail is a finding (eight found so far); any behavior tested
in only one SDK is suspect.

## Architecture in one screen

**Three planes.** Authoring/control (immutable revisions, validation, atomic activation,
optimistic concurrency, rollback, audit) → distribution (var server over pluggable transports)
→ consumer SDK (fetch/watch/cache/LKG).

**Key resolution is indirect.** Keys are `var.<group>.<rest>`; the manifest maps group → source.
Read sites never name a remote, so repointing a group is a manifest-only change.

**Overlay precedence** (the property that lets a service move static → runtime without touching
call sites): active runtime revision → statically projected `value.<group>.<rest>` → schema
`default`. Deactivating the runtime head cleanly restores the static value with no deployment.
`value.*` reads themselves are never remote-affected — the overlay exists only on the `var.*` path.

**Server is library-first, never a sidecar.** `varServer(store)` mounts into an existing
HTTP server; `attachVarRpc(grpcServer, store)` registers on an existing `grpc.Server`.
`cnos var serve` is the same library plus a `main()`. Consumer push is equally latching:
a mountable handler on the host's own server, never a CNOS-owned listener.

**Persistence is a store property, not a server mode.** `memoryStore()` (ephemeral; on restart
the head is absent and consumers degrade to static/default) vs `fileStore(path)` (append-only
event-sourced JSONL: revision-created/activated/deactivated/rejected → audit, history,
replay-to-generation, restart resume).

## Round 3 — findings and fixes

Round 3 found **eight** more real defects. Every one was again in **lifecycle or cross-SDK
semantics**, exactly where round 3 was aimed. All eight are fixed, each with a test on BOTH SDKs.

| # | Severity | Defect | Fix |
|---|---|---|---|
| 1 | blocker | **rpc reconnect never re-pulled subscribed scopes.** Both SDKs only reopened the stream, and the server forwards FUTURE commits only, so an activation *or a deactivation* during an outage/backoff was lost permanently. Since round 2 made deactivation a real state change, a missed one meant serving withdrawn policy forever — with no poller to converge (capability rule). | New SDK seam `onSubscriptionConnected` / `OnSubscriptionConnected`. The provider reports every (re)connect AFTER issuing Subscribe; the SDK re-pulls each subscribed scope through the normal pull path (`no-head` → scope removal included). First connect skips scopes with an applied head; every reconnect pulls everything. |
| 2 | blocker | **`close()` racing an in-flight startup.** `close()` cleaned only the CURRENT providers/timers/subscriptions; a startup still awaiting prefetch went on to create new ones that were never released, and could report success for an already-closed runtime. | Runtime cancellation cancels the prefetch (Go derives the fetch ctx from caller ctx AND runtime ctx); startup re-checks `closed` after every wait and before creating any long-lived resource; `close()` waits for the attempt to stop; a start on a closed runtime fails (`ErrVarClosed` / thrown). |
| 3 | blocker | **Node bypassed required enforcement when the provider module was missing.** The round-2 `ProviderUnavailableError` branch `return`ed before the post-outcome required check, so a missing transport module + a required prefetch key + no fallback made Node report READY where Go rejected `StartVars`. | The missing module is still warned, but the required check ALWAYS runs. Startup stays non-fatal only while every required key of the group resolves from static/default. |
| 4 | blocker | **Go merged group snapshots instead of replacing the scope.** `commit` copied all old records then overlaid the updates, so a key present in revision 1 and absent from revision 2 kept being served — a removed allowlist entry or a revoked policy flag persisting indefinitely. Security-relevant staleness on the feature's flagship use case. | Go's store is now keyed by SCOPE, holding each scope's whole batch (Node's shape). A commit replaces the exact scope; other scopes are untouched. Rule implemented and documented: **longest committed dot-prefix scope serves a key; a missing key does not fall through to a broader scope; replacement is per exact scope string.** |
| 5 | warning | **No ordering between a `no-head` and an in-flight pull.** A stale pull could reintroduce a head after a deactivation; a delayed `no-head` could clear a newer pushed activation — indefinitely for an ondemand/rpc source. | Monotonic per-scope **operation epoch**, bumped on every authoritative application (including a `no-head` that removes nothing). Pushes always apply; a pull applies only if the epoch is unchanged on completion. Pinned as a contract DISTINCT from out-of-order-push last-write-wins. |
| 6 | warning | **Watcher notification was not ordered against concurrent/reentrant mutation.** A reactivation triggered inside a deactivation callback made later watchers observe the reactivated value and skip the fallback transition; in Go, concurrent notify loops could deliver an older activation after a newer deactivation. | Each commit freezes an immutable event (registry as of the commit + `prev`/`next` captured around the mutation) and queues it in commit order; one event is delivered to EVERY watcher before the next starts. |
| 7 | warning | **Node rollback did not release providers created by the failed attempt.** A provider whose `subscribe()` allocated and then threw stayed cached and was never closed; the retry reused the poisoned instance. | The attempt snapshots the provider map; rollback closes and evicts providers it created, so a retry goes back to the factory. |
| 8 | warning | **Go skipped refresh metadata on an empty `no-head`.** `applyNoHead` returned at the `len(removed) == 0` check before updating `lastRefreshAt`/`lastError`, so after a transport failure followed by a definitive `no-head` on an empty store Go kept reporting the stale error while Node reported recovery. | Metadata is updated for every valid `no-head`; only the watcher notification and the deactivation warning depend on whether records were removed. |

### Additional defects surfaced while fixing these

- **Node reported `source: 'runtime', value: undefined`** for a key inside a committed scope whose
  revision did not carry it (found by the blocker-4 test). Reads already fell back correctly, but
  `varSnapshot()`, `varStatus()` and watchers did not, and `hasRuntimeScope` suppressed the
  ondemand fetch Go would have made. Coverage is now per KEY in both SDKs (`servingScope`).
- **The Go receiver committed at the collapsed GROUP** where the Node receiver commits at the
  pushed SCOPE. Harmless while everything was merged; a divergence once a revision replaces its
  scope. Go now commits at the pushed scope.

### Revert-verification (blockers 1, 3, 4)

Each new test was confirmed to FAIL with its fix reverted:

| Fix reverted | Failing test |
|---|---|
| 1 — drop `onSubscriptionConnected` wiring (Node) | `var-rpc` `#reconnect re-pulls … ACTIVATION` and `… DEACTIVATION` both fail after the 15 s convergence window |
| 1 — set `OnSubscriptionConnected: nil` (Go) | `TestRpcReconnectResyncRestoresStaticTierEndToEnd` fails ("a deactivation missed during the outage was never resynced") |
| 3 — restore the early `return` in `prefetchGroup` | `(c) a MISSING transport module with NO fallback still fails ready()` and `a missing transport module still fails ready() when a required key has no fallback` |
| 4 — restore merge semantics in `varStore.commit` (Go) | `TestVarRevisionReplacesScopeAndDropsVanishedKeys` ("got b1") |
| 4 — merge the previous batch values in `LiveVarStore.ingest` (Node) | `a replacement revision DROPS a key the previous revision carried` |

Blocker 3's Go behavior was already correct before this round (Go's `fetchGroup` surfaces the
missing provider as a fetch error, which the required loop then catches). Its Go test is new
COVERAGE of the mismatch, not a regression test for a Go fix — which is precisely why the
divergence survived: the Go suite only covered the with-fallback case.

### Tests that asserted nothing (running total: 7)

The two reconnect tests (`packages/var-rpc/test/integration.test.ts`, `packages/go/varrpc`)
repeatedly activated until a commit landed after reconnection, so they passed with no resync
whatsoever. Both are replaced: the new tests mutate **exactly once, while disconnected**, and
assert convergence with no further mutations. The surviving stream-level Go test now waits for a
real re-subscription and publishes a single activation afterwards.

## Round 3 — where round 3 was aimed (for the record)

Rounds 1 and 2 found **eight** real defects. Every one was in **lifecycle or cross-SDK
semantics**; none were in steady-state ingest, validation, or the secret boundary. That is
where the 160-test hardening sweep concentrated, and evidently where it did not. Aim round 3
at the same seam:

1. **Deactivation now actually mutates state** (round-2 blocker 1). It is newly exercised code:
   check no-head racing an in-flight pull, a no-head arriving while a watcher callback runs,
   deactivate→reactivate ordering, and whether `lastKnownGood` / `lease` / `freshness` still
   mean anything sane once the runtime tier is gone.
2. **Startup and shutdown ordering.** Round 2 changed startup in three ways (shared in-flight
   attempt, caller ctx, transactional rollback). Look for: `close()` racing a startup attempt,
   rollback leaving a half-registered provider, a retry after rollback double-registering, and
   whether a ctx cancelled *during* prefetch leaves the attempt claimable.
3. **rpc reconnect × the new no-head path.** A reconnect re-pulls subscribed scopes; a
   deactivation that lands during a terminal-failure backoff may never be observed.
4. **Cross-SDK parity, again.** Both rounds found Node and Go disagreeing on lifecycle. The
   wire is fixture-pinned; the *semantics* are not. Treat any behavior where only one SDK has a
   test as suspect.

**A recurring failure mode worth targeting directly: tests that assert nothing.** Four had
been found so far — a synthetic empty-batch "deactivation" no transport emits, an rpc test that
pinned a bug as correct, a WSL low-port hang that silently disabled a retry assertion, and three
`var-http` tests that only passed *because* of the round-2 blocker. If a test looks like
coverage, check that it fails when the behavior is broken.

## What to review hardest

1. **Overlay precedence correctness** — `packages/core/src/runtime/readVar.ts`,
   `orchestrator/runtime.ts`. Especially: `required: true` fail-fast paths, and that a
   *declared* `default` is distinguishable from an absent one (JSON absence ≠ `false`/`null`).
2. **Atomicity** — `varStore.ts` (Node) and `var_store.go` / `var_runtime.go` (Go). Readers must
   never observe a partially-applied batch. Node relies on immutable snapshot swap; Go on
   `atomic.Pointer` copy-on-write CAS. `removeScope` (new in round 2) must hold the same
   discipline. Race-detector verified — see Verification status.
3. **Validate-before-commit** — an invalid revision must never replace last-known-good, on both
   the authoring side (`var-server/src/engine.ts`) and consumer ingest.
4. **Secret boundary (Critical Rules 4/5)** — `var.*` documents carry opaque `secret.*` refs only.
   Verify nothing leaks into: `varStatus()`, server status/history, the fileStore log, error
   messages, stderr warnings, public/browser surfaces. W5b asserts this by seeding a real secret
   and grepping those surfaces for the literal string — check the assertions are actually
   load-bearing.
5. **Optimistic concurrency** — `activate` requires `expectedGeneration`; a stale write must 409,
   never overwrite. W5b has a 12-way concurrent-activate race asserting exactly one winner.
6. **Cross-SDK parity** — Go and Node were built by separate agents and reconciled twice
   (W4.5 wire shapes, W5d semantics). `fixtures/var-cross-sdk/` is the wire source of truth,
   asserted by both a vitest test and a `go test`. **Any new divergence should break CI** — worth
   confirming that claim holds.
7. **Backward compatibility** — a projection with no var blocks must behave byte-identically to
   pre-feature: no timers, no sockets, `close()` a no-op, `toServerProjection` output unchanged.
   Explicitly tested; verify the test really pins byte-equality.

## Defects found and fixed (context for reviewers)

W5b was run specifically to find bugs and found 11. All are fixed in `7c6e85c` / `78a8d10`, and
each W5b "pin" (a test that encoded the buggy behavior) was flipped to assert correct behavior.
Grep `DEFECT-PIN` / `DIVERGENCE` — only a header comment should remain. The notable ones:

- **rpc Subscribe failure handling was wrong in opposite directions in the two SDKs.** Node died
  *silently* on auth failure (root cause: `call.destroy(status)` on a grpc-js server stream tears
  the call down locally and never puts a status on the wire — the client got literally nothing,
  forever, and since the poller only covers `http` sources that rpc source went permanently dark).
  Go retried *forever* with no cap. Now both: `UNAUTHENTICATED`/`PERMISSION_DENIED` are terminal,
  transport failures retry bounded (cap 8), state surfaces as `subscription: active|retrying|failed`.
  Deliberately **no** fallback to polling on terminal failure — same credentials would be refused
  by `Pull`, and a silent poll loop would hide the failure the terminal state exists to advertise.
- **Node receiver had no body-size limit** (Go capped at 1 MiB) and **accepted unauthenticated
  pushes when `verify` was omitted** (guard was `if (source?.verify && …)`, so omitting the ref
  skipped verification entirely — open by omission). Both now fail closed, both SDKs agree on 413.
- **int64 generations corrupted at the Node rpc edge** (`Number()` is exact only to 2^53−1).
  Landed as detect-and-reject (`var.generation-range`) rather than a widened carrier — see gaps.
- **Admin GETs were authorized as `read`** despite exposing the full audit log; now a distinct
  `audit` kind. **Mutation scope never reached the authorize hook** (parsed from query only, but
  mutations carry scope in the body) — this is why acceptance #12 was structurally impossible on
  writes; now fixed and tested.
- **Watcher dispatch was gated on `(revision, generation)`**, but a revision-less push is stamped
  with a wall-clock generation — so replaying an identical document woke every watcher, defeating
  the idempotent-replay property. Now gated on the content-addressed revision alone.

## Review round 1 — findings accepted and fixed (`3a292ef`)

Both findings from the first external review pass were valid and are fixed, each with a
regression test:

1. **[Blocker] Go gated `Ready` on required *ondemand* vars.** `start()` validated every
   required rule regardless of its group's mode, so a required ondemand key with no static or
   default tier failed `StartVars`. Node only resolves prefetch groups during `ready()`, so the
   same manifest booted under Node and failed under Go. The ADR is explicit that ondemand is
   fail-fast *lazily* (`refreshVar` / `read` / `Require`), never at startup — Node was right.
   The gate is now restricted to prefetch groups.
2. **[Medium] A failed start latched the runtime as "started"** — and the impact was worse than
   reported: the next `ready()`/`StartVars` did not merely skip the retry, it **resolved
   successfully** with no pollers or subscriptions running, silently serving only fallback
   tiers. Both runtimes now clear the latch on failure. **The Go side had the identical flaw,
   which the review did not flag** (`variables.started` was set before the work and never
   reset); it is fixed in the same commit. Node keeps an in-flight promise so concurrent
   `ready()` calls still share one startup.

The Node regression test was verified to fail with the fix reverted, so it genuinely pins the
behavior rather than passing either way.

## Review round 2 — findings accepted and fixed

All six findings from the second external review pass were valid. Each is fixed in both SDKs with
a regression test; the two the reviewer asked to be revert-verified were confirmed to FAIL with the
fix reverted.

1. **[Blocker] Deactivation never cleared an applied runtime snapshot.** A `no-head` only recorded
   a refresh, so a deactivated revision kept being served; worse, the rpc clients DROPPED `no_head`
   push events, and an rpc source runs no poller — so an rpc consumer could serve a deactivated
   revision forever with no pull to converge on. Both SDKs now route every `no-head` (pull AND
   push, http AND rpc) through an atomic scope removal (`LiveVarStore.removeScope` /
   `varStore.removeScope`), notify watchers with the static/default snapshot that took over, and
   clear the head's generation/revision from status. A transport error is still NOT a no-head and
   retains last-known-good; removal is idempotent. The TS provider `subscribe` callback now takes a
   `VarPushEvent` (`{ kind: 'batch' | 'no-head', scope?, batch? }`), mirroring Go's existing
   `VarBatchResult.Status`.
2. **[Blocker] Node checked required-resolvability only in the exception path.** `fetchScope`
   returns `no-head` / `rejected` without throwing, so a required prefetch group with no head and
   no fallback let Node's `ready()` SUCCEED while Go correctly failed. The check now runs after
   every outcome. `refreshVar` on a required key also rejects on a validation-`rejected` revision
   (Go's ingest rejection already surfaced as `ErrVarRequired`) — but deliberately NOT on a
   `no-head`, which is a definitive answer and stays fail-fast lazily, per the pre-existing Go
   contract in `TestVarRequiredOndemandDoesNotBlockReady`.
3. **[Blocker] Go did not share an in-flight startup.** `started = true` before the work meant a
   concurrent `StartVars` returned `nil` early — a false success if attempt #1 then failed.
   Replaced with a shared `varStartAttempt` (completion channel + result); the attempt is cleared
   on failure and kept on success. Verified under `-race`.
4. **[Warning] `StartVars(ctx)` ignored its context.** Prefetch now runs on the caller's ctx (so a
   deadline actually bounds startup); pollers and subscriptions keep the runtime-lifetime ctx
   because they must outlive a ctx routinely cancelled the moment `Ready()` returns. Node has no
   analogous path — its `start()` takes no ctx and its providers own their own timeouts.
5. **[Warning] Poller capability diverged.** Canonical rule, now identical in both SDKs and
   documented: poll only when the provider does NOT implement `subscribe`. A `pollInterval` on a
   subscribe-capable source is ignored and warned once per source.
6. **[Warning] Node startup was not transactional.** `VarManager.start()` now rolls back the
   timers/subscriptions its failed attempt created, so the retry permitted by the round-1 latch fix
   starts clean; `close()` remains correct afterwards. Go has no equivalent hazard — its startup
   creates nothing until after the last fallible step.

Fixture/doc follow-through: the existing `snapshot-batch-no-head.bin` already carried the `scope`
field that is now load-bearing, so both wire tests were extended to pin its presence rather than
adding new bytes.

## Pinned behaviors (encoded as contract where the design was silent)

Worth a reviewer's judgement — these were decided by observing the code, not from first principles:

- ~~A deactivation "delivers a batch with the key absent"~~ — **retired in round 2.** No transport
  emits that; it was a synthetic stand-in that made the acceptance-#15 test pass against a store
  that never cleared anything. The real representation is a `no-head` → scope removal.
- ~~The rpc provider drops `no_head` pushes and "the SDK converges on the next pull"~~ — **retired
  in round 2**: an rpc source has no poller, so there is no next pull.
- **Out-of-order push conflict rule is last-write-wins** in both SDKs; there is no generation or
  revision comparison on ingest. The ADR's earlier "highest revision wins" idea is *not* what ships.
- Freshness edges are strict: `fresh` *at* ttl, `stale` *at* lease. Negative age (clock skew) → fresh.
- `effectiveAt` is never ordering-checked.
- Empty scope classifies as a GROUP; a trailing dot makes it a KEY.
- Ondemand fetches are **group-scoped** (never a bare key), deduped to one in-flight fetch per group.

## Known gaps (accepted, not blockers)

1. ~~`go test -race` has never been run~~ — **RESOLVED.** Run under WSL2 Debian (Go 1.26.3,
   gcc 14.2.0) via `bash scripts/race-check.sh`: **PASS on both Go modules, no data races
   detected.** Re-run it in CI on any Linux/macOS runner; it self-locates Go and fails loudly
   if no C compiler is present.

   That run also exposed a genuine test-portability bug, now fixed (`a65b574`): several tests
   dialed hardcoded low ports (`127.0.0.1:1`, `:9`) assuming an instant `ECONNREFUSED`. WSL2's
   localhost forwarding swallows low-port connections — they hang until timeout instead of
   refusing — so `TestSubscribeRetriesAreBoundedByTheFailureCap` failed deterministically there
   while passing on Windows. Tests now reserve an ephemeral port and close it, which refuses on
   every platform. This was a test bug, not a product defect: the bounded-retry policy itself
   was never exercised because the connection never failed.
2. **int64 generations above 2^53−1 are rejected, not carried.** Loud failure instead of silent
   corruption, but an authority serving both SDKs must keep generations below that bound.
3. **`ws`/`sse` are schema-only** — accepted by the manifest enum, no provider exists.
4. **Scoped authz (acceptance #12) is a v1 hook**, not full least-privilege. `staticBearerAuthorize`
   does not distinguish the new `audit` kind; real scoping needs a custom hook.
5. **rpc has no TLS credentials** — insecure by default in `serveVarRpc` and the Go dialer.
6. **Full-suite flakiness is PRE-EXISTING and unrelated.** `pnpm -r test` intermittently fails under
   parallel load with different tests each run (temp-dir `ENOTEMPTY` races, a 15s codegen compile
   timeout, a CLI spec test). Verified by stashing all var work and re-running — still fails.
   Every package passes in isolation. Do not attribute this to the branch.

## Verification status (this machine)

| Check | Result |
|---|---|
| `pnpm -r typecheck` | pass (0) |
| `pnpm -r build` | pass (0) — all 29 projects |
| `pnpm -r test` | passes per-package; full parallel run flaky, see gap 6 |
| `packages/go`: build / vet / test | pass |
| `packages/go/varrpc`: build / vet / test | pass |
| `GOWORK=off go build ./...` (root Go) | pass — still stdlib-only, `go.mod` requires only `gopkg.in/yaml.v3` |
| `go test -race` (both modules) | **PASS** — no data races (WSL2 Debian, Go 1.26.3 + gcc 14.2.0; `bash scripts/race-check.sh`) |
| `pnpm -r lint` | passes except `vault-testkit` ("No files matching pattern test" — pre-existing, no test dir) |

## Dependency review

Only two new third-party dependencies, both approved and **contained**:

- `@grpc/grpc-js` + `@grpc/proto-loader` → **only** in `packages/var-rpc`.
- `google.golang.org/grpc` → **only** in the new `packages/go/varrpc` submodule.

`@kitsy/cnos` does **not** depend on `var-rpc` (rpc registration is explicit opt-in), and the root
Go module is unchanged — verify `packages/go/go.mod` is untouched in the diff. Everything else in
the feature (server, stores, http transport, receiver) is stdlib/built-ins only.

## Release-readiness notes

Publish config was a real blocker, now fixed in `be28ae7` — worth re-verifying:

- All four new packages shipped `private: true`, but `@kitsy/cnos` depends on `var-http` and the
  CLI on `var-rpc`/`var-server` **at runtime**. Publishing would have shipped packages whose
  dependencies don't exist on npm. `var-server`/`var-http`/`var-rpc` are now public;
  `var-testkit` stays private (dev-only, mirrors `vault-testkit`).
- `publish-go.yml` now tags `packages/go/varrpc/v${VERSION}`.
- `release.sh` now repoints every Go submodule's parent requirement to the released version. Go
  resolves that from published tags, not `go.work`, so `varrpc` pinned at the stale `v1.11.4`
  would have given consumers a parent predating the entire var API. (All vault submodules had the
  same stale pin — harmless for them, fixed uniformly.)
- Publish order matters: `core` → `var-server` → `var-http`/`var-rpc` → `cnos` → `cli`.

## Suggested review commands

```bash
git diff main...var-runtime --stat
git log main..var-runtime --oneline

# The riskiest surfaces
git diff main...var-runtime -- packages/core/src/runtime/varStore.ts \
  packages/core/src/runtime/readVar.ts packages/var-server/src/engine.ts \
  packages/go/var_store.go packages/go/var_runtime.go

# Wire contract source of truth (asserted by both toolchains)
ls fixtures/var-cross-sdk/

# Should return only a header comment
grep -rn "DEFECT-PIN\|DIVERGENCE" packages/
```
