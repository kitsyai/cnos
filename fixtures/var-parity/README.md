# `var.*` cross-SDK SEMANTIC parity spec

`fixtures/var-cross-sdk/` pins the **wire**. This directory pins the **semantics**.

Node and Go were built by separate agents. Three review rounds found 16 defects and almost every
one was the two SDKs disagreeing about observable *lifecycle* behavior that byte/JSON fixtures
structurally cannot catch — ondemand gating `Ready` in one SDK only, a missing provider module
waiving the required check in one SDK only, a merged scope serving a REMOVED allowlist entry, a
`no-head` clearing state in one SDK and not the other.

The scenarios here are **data, not code**: one declarative spec, executed by a thin interpreter in
each SDK against its own public API. Hand-written twin suites drift, which is the very failure this
exists to prevent.

| Runner | Drives |
|---|---|
| `packages/cnos/test/var-parity.test.ts` | `createSingletonVarSupport` — the real projection-bootstrap wiring: `start`, `readVar`, `varSnapshot`, `manager.{refreshVar,refreshVars,watch,status,close}` |
| `packages/go/var_parity_test.go` | `LoadProjection` + `Runtime.{StartVars,Var,VarSnapshot,RefreshVar,RefreshVars,Watch,VarStatus,Close}` |

Both run inside the ordinary suites (`pnpm -r test`, `go test ./...`). Neither is opt-in — an
opt-in parity suite rots.

## Scenario format

One file per axis under `scenarios/`, each holding a JSON **array** of scenarios.

```jsonc
{
  "name": "unique-kebab-name",
  "axis": "startup|read|deactivation|scope|ordering|watch|freshness|status|close",
  "why": "which review finding / ADR clause this pins",
  "projection": {
    "values":     { "policy.mode": "static-value" },      // tier ②, keyed by the PREFIX-STRIPPED key
    "varSources": { "svc": { "transport": "fake" } },     // "fake" | "missing"
    "vars":       { "policy": { "source": "svc", "mode": "prefetch", "ttl": "60ms", "lease": "180ms" } },
    "schema":     { "var.policy.mode": { "type": "string", "required": true, "default": "d" } }
  },
  "source": { "policy": { "kind": "head", "generation": 7, "revision": "sha256:r1",
                          "effectiveAt": "…", "values": { "policy.mode": "live" } } },
  "steps": [ { "action": "start" }, { "action": "expect", "startOutcome": "ok" } ]
}
```

- **Keys are always full `var.…` keys** in steps and expectations; each runner strips as its API
  needs. `values` and a source response's `values` are keyed by the prefix-stripped key, exactly
  like every wire payload.
- **Transports are aliases, not real transports.** `fake` is the in-process parity source (mapped
  onto `ws`, which ships no provider in either SDK); `missing` (mapped onto `sse`) is a source for
  which NO provider module is registered — the deployment-gap axis. The fake implements the same
  outcomes the http wire defines: `head` (200), `not-modified` (304), `no-head` (404
  `{code:"no-head"}`), `error` (transport failure), plus pushed `batch` / `no-head` events through
  the provider `subscribe` seam.
- **Do not name a group `flags`, `config`, `process` or `public`** — those are reserved projection
  namespaces in both SDKs and a `value.<group>.…` fallback will not resolve. Use `policy`.

### Actions

| Action | Meaning |
|---|---|
| `start` / `startAsync` / `awaitStart` | run the startup attempt (awaited, or left in flight) |
| `close` / `closeAsync` / `awaitClose` | close the runtime |
| `setSource` (`scope`, `response`) | change what the fake answers for a scope |
| `blockPull` / `releasePull` (`scope`) | gate a pull so ordering/lifecycle races are deterministic |
| `awaitPullIssued` (`scope`, `count`) | condition-poll until the fake has seen N pulls |
| `push` (`scope`, `event`) | deliver a subscription event (`batch` or `no-head`) |
| `read` (`key`) | record value + tier + freshness as `lastRead` |
| `awaitRead` (`key`, `source`) | condition-poll until a key resolves from a tier (ondemand convergence) |
| `refreshVar` (`key`) / `refreshVars` / `refreshVarsAsync` / `awaitRefresh` | refresh paths |
| `watch` (`id`, `key`, `then?`) / `unwatch` (`id`) | register/stop a watcher; `then` runs ONE reentrant step from inside the first fire |
| `sleep` (`ms`) | real elapsed time (freshness only) |
| `expect` | assert (below) |

An action a runner does not implement **fails loudly as unsupported**. Never add a silent skip.

### Expectations

`startOutcome` · `startErrorKind` · `refreshOutcome` · `refreshErrorKind` · `closeOutcome` ·
`closeSettledWithinMs` + `settled` · `read` (`found`, `value`, `source`, `freshness`) ·
`status` (`key`, `source`, `freshness`, `appliedGeneration`, `revision`†, `desiredGeneration`†,
`lastError`†, `lastRejected`†) · `watch` (`id`, `fires`, `unordered?`).

† booleans — field PRESENCE, because the SDKs represent absence differently (`undefined` vs `""`).

**Error text is never normative; the KIND is.** Kinds are `required` (`CnosVarRequiredError` /
`ErrVarRequired`), `closed` (the closed-runtime failure) and `other`. Each runner owns the mapping
from its own error representation to the kind.

## Divergence policy

Running this matrix surfaces places where the SDKs still disagree. **Never** reconcile by weakening
an assertion or deleting a scenario.

- If the ADR (`docs/cnos-runtime-vars.md`) unambiguously specifies the correct behavior: **fix the
  wrong SDK**, and keep the scenario normative.
- If the ADR is silent or ambiguous: record it as a divergent expectation. Both observed behaviors
  are written into the spec; each runner asserts **its own** recorded side and reports the
  divergence without failing the build. If either side drifts again, the assertion fails.

```jsonc
{
  "action": "expect",
  "status": "divergent",
  "note": "DIVERGENCE-n: what differs and why neither side is provably wrong",
  "adr": "docs/cnos-runtime-vars.md - <section> (what it does NOT say)",
  "observed": { "node": { "refreshOutcome": "ok" }, "go": { "refreshOutcome": "error" } }
}
```

Each runner prints the divergences it exercised at the end of the run.

## Adding a scenario

1. Add an object to the axis file under `scenarios/` (or a new axis file — both runners glob the
   directory). Give it a unique `name` and a `why` naming the finding or ADR clause it pins.
2. Run `pnpm --filter @kitsy/cnos test` and `go test ./... -run TestVarSemanticParity` in
   `packages/go`. **Both must run it — a scenario only one runner executes is not parity.**
3. If the two disagree, apply the divergence policy above. Do not "fix" the spec to match.
4. Prove it is not vacuous: break the behavior in one SDK and confirm the scenario fails.

If a new scenario needs a new ACTION, implement it in both runners in the same commit.

## Deliberately not expressed here

Recorded so nobody assumes coverage that does not exist:

- **Freshness boundary strictness** (`fresh` *at* ttl, `stale` *at* lease) and **negative age /
  clock skew**. Neither SDK exposes an injectable clock on this path, so the suite uses real
  millisecond sleeps and can only test the interiors of the windows. Boundaries stay covered by the
  per-SDK unit tests.
- **A narrower independently-authored scope surviving a broader commit.** Both SDKs only ever
  commit at GROUP scope through the consumer API (prefetch, ondemand and subscribe pushes all
  collapse to the group), so a key-scoped commit is unreachable from the public surface. It is a
  store-level property, covered per SDK.
- **Poller cadence and rpc reconnect/resync mechanics.** The parity fake is subscribe-capable, so —
  per the canonical capability rule — it is never polled. Reconnect is covered by the rpc
  integration tests in both toolchains (W9).
- **The push receiver surface** (`varReceiver` / `VarReceiver`): a different, http-shaped surface
  with its own per-SDK suites.
