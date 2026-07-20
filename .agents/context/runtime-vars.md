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
| In-memory live store: per-scope snapshots, atomic ingest, freshness calc, watch dispatch, status | `packages/core/src/runtime/varStore.ts` (`LiveVarStore`) |
| Orchestrator-facing coordinator: provider construction, prefetch/ondemand lifecycle, pollers (http `If-None-Match`), refresh, receiver ingest routing | `packages/core/src/runtime/varManager.ts` (`VarManager`) |
| Core runtime wiring (`createRuntime`): `var()`, `varSnapshot()`, `varStatus()`, `refreshVar()`/`refreshVars()`, `watch()`, `close()`, internal `__startVars`/`__ingestVar`/`__varSource`/`__resolveVarSecret` hooks used by the receiver | `packages/core/src/orchestrator/runtime.ts` |
| `ServerProjection` var blocks (`varSources`, `vars`, `documents`, `schema` keyed by full var key, `default` emitted only when declared) | `packages/core/src/runtime/toServerProjection.ts` |
| Derived-value integration: `var.*` refs are valid (unlike `secret.*`/`public.*`) but make the derivation runtime-dependent (never cached) | `packages/core/src/derive/validate.ts`, `packages/core/src/derive/runtime.ts` |
| New error types (`CnosVarRequiredError`, `CnosVarNoHeadError`, `CnosVarNotModifiedError`) | `packages/core/src/errors.ts` |
| Control-plane engine: `createRevision`/`validateRevision`/`activate`/`deactivate`/`rollback`/`status`/`history`/`replay`, per-scope serialized locking, optimistic concurrency | `packages/var-server/src/engine.ts` (`VarEngine`) |
| Pluggable `VarStore` contract + `memoryStore()` + `fileStore(path)` (append-only JSONL, replay, restart resume) | `packages/var-server/src/types.ts`, `memoryStore.ts`, `fileStore.ts`, `baseStore.ts` |
| Embeddable HTTP handler (`varServer(store, opts)`) + standalone wrapper (`serveVarServer`, backs `cnos var serve`) | `packages/var-server/src/httpServer.ts`, `serve.ts` |
| Authorization hook (`allowAllWithWarning`, `staticBearerAuthorize`) | `packages/var-server/src/authorize.ts` |
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

## Wire conventions (canonical — verify against `fixtures/var-cross-sdk/` before writing any example)

- **Uniform values keying.** In every pull response, push payload, and http read response, `values` is keyed by the **full var key minus the `var.` prefix** — for BOTH key- and group-scoped batches. A key-scoped batch wraps the document: `{ "<scope>": doc }`. A group-scoped batch passes the document through as-is (already keyed by full stripped keys); the var-server enforces that shape at revision-create/validate time (`var.group-scope-shape`).
- **Scope-kind rule** (shared by TS and Go, syntactically decidable): a scope with no dot is a GROUP (`agentic`); a scope with a dot is a KEY (`agentic.lanes.vinci`). See `isVarGroupScope`/`isVarKeyScope` in `readVar.ts`.
- **Receiver verification codes**: `204` accepted, `401` signature/bearer verification failed, `422` validation-rejected (last-known-good kept, body carries `issues`), `400` malformed request (missing scope, missing `values`, bad JSON), `503` var runtime not ready, `405` non-POST.
- **Signature header**: `x-cnos-signature: sha256=<hex hmac-sha256 of the raw request body>` — the `sha256=` prefix is REQUIRED and part of the comparison. Falls back to `Authorization: Bearer <token>` compared against the same `verify` secret when the signature header is absent. Identical scheme in the Node (`varReceiver.ts`) and Go (`var_receiver.go`) receivers.
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

`packages/var-rpc` (gRPC transport, `cnos.var.v1`) is **in progress in the main tree, not in this worktree** — the manifest's `transport` enum already reserves `rpc` for it. Treat it as a separate docs follow-up; do not document its API surface until it lands.

## Design-doc vs implementation discrepancies (report, do not silently "correct" the design doc)

The design doc (`docs/cnos-runtime-vars.md`) is largely accurate post-implementation, but a few points drifted or were resolved more narrowly than drafted:

1. **Ondemand fetch granularity.** The design doc doesn't specify fetch granularity for `ondemand` reads. The implementation always fetches the **whole group** on first miss (one deduped in-flight fetch per group), never a bare single key — see `VarManager.maybeTriggerOndemand`. Document this as the actual behavior, not "the key is fetched."
2. **`ws`/`sse` transports and `rpc` are not implemented.** The design doc lists `rpc → http → ws → sse` as the transport priority with all "shipped by CNOS." As of W1-W4.5, only `http` has a working provider (`packages/var-http`); `rpc` is in progress in a sibling worktree; `ws`/`sse` are schema-only (accepted by manifest validation, no provider module exists). Docs should say this plainly rather than imply all four exist today.
3. **`varStatus()` field semantics differ slightly by layer.** The design doc's single example status object mixes the consumer-SDK shape (`desiredGeneration`/`appliedGeneration`/`snapshotAge`) with what is actually two distinct shapes in code: the consumer `VarScopeStatus` (core `types/var.ts`) and the server's own `ScopeStatus` (`var-server/src/types.ts`, `{ scope, active, generation, revision?, source, lastRejected? }`, no `desiredGeneration`/`snapshotAge`/`freshness`). Both are documented separately in the new guide to avoid implying they're the same object.
4. **Lease vs ttl "open decision" is resolved in code, not just decided in prose.** The design doc lists "lease vs ttl naming/merge" as an open decision. The implementation ships both as separate fields with distinct semantics (`ttl` = staleness threshold, `lease` = fail-closed/expiry threshold) — see `LiveVarStore.freshnessFor` in `varStore.ts` and the mirrored Go `computeFreshness`. Worth updating the design doc's "Open decisions" section to mark this resolved, but that edit was left to whoever owns the ADR next (out of scope for this docs-only pass beyond noting it here).
5. **Receiver route/URL shape is a convention, not enforced.** The design doc implies a fixed `POST /cnos/vars/:scope` receiver path. In code, `varReceiver()` (Node) and `VarReceiver()` (Go) only require the target scope to be the **last path segment** of whatever URL you mount them at — the base path is entirely up to the host. Docs should present `/cnos/vars/push/:scope` as an example convention, not a fixed contract.
