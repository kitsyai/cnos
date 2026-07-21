# Review Handover — `var.*` Runtime Variables (`main...var-runtime`)

**Branch:** `var-runtime` (12 commits ahead of `main`, clean tree, nothing pushed)
**Size:** 134 files, +18,974 / −37
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

## What to review hardest

1. **Overlay precedence correctness** — `packages/core/src/runtime/readVar.ts`,
   `orchestrator/runtime.ts`. Especially: `required: true` fail-fast paths, and that a
   *declared* `default` is distinguishable from an absent one (JSON absence ≠ `false`/`null`).
2. **Atomicity** — `varStore.ts` (Node) and `var_store.go` / `var_runtime.go` (Go). Readers must
   never observe a partially-applied batch. Node relies on immutable snapshot swap; Go on
   `atomic.Pointer` copy-on-write CAS. **Not race-detector verified** (see Known gaps).
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

## Pinned behaviors (encoded as contract where the design was silent)

Worth a reviewer's judgement — these were decided by observing the code, not from first principles:

- **Out-of-order push conflict rule is last-write-wins** in both SDKs; there is no generation or
  revision comparison on ingest. The ADR's earlier "highest revision wins" idea is *not* what ships.
- Freshness edges are strict: `fresh` *at* ttl, `stale` *at* lease. Negative age (clock skew) → fresh.
- `effectiveAt` is never ordering-checked.
- Empty scope classifies as a GROUP; a trailing dot makes it a KEY.
- Ondemand fetches are **group-scoped** (never a bare key), deduped to one in-flight fetch per group.

## Known gaps (accepted, not blockers)

1. **`go test -race` has never been run** — no cgo/C toolchain on the dev machine. Highest-value
   targets: `TestVarAtomicSnapshotsUnderConcurrency`, `TestVarWatchPrefixAndExactMatching`,
   `TestSubscribePinnedAuthFailureRetriesForever`, and `varrpc`'s subscribe/close tests.
   **Recommend running on macOS/Linux before or immediately after publish.**
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
| `go test -race` | **NOT RUN** — no cgo toolchain |
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
