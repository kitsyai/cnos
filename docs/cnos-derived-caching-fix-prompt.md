# Codex Prompt — Resolve Derived Value Caching Contradiction

## Context

The derived values implementation has a contradiction between two statements:

1. "process.env.* derivations should change on re-read" (DRV-P-2)
2. "server projection derived results are cached for the runtime lifetime"

These cannot both be true. This prompt resolves the contradiction.

## The Resolution

The authoritative document is `cnos-derived-values.md` (attached). Use §5 "Evaluation Model and Caching" as the single source of truth. The core rule:

**Config-only derivations** (all dependencies are config namespaces like `value.*`, `meta.*`) → **cached once per resolution pass**. Same result on every read until the next `createCnos()`.

**Runtime-dependent derivations** (any dependency, direct or transitive, is a runtime namespace like `process.*`, `request.*`, `session.*`) → **never cached. Evaluated fresh on every read.**

## What to Change

### 1. Evaluator caching logic

In the `evaluateDerived()` function, the cache check must include a runtime-dependency guard:

```ts
// Cache check — ONLY for non-runtime-dependent derivations
const parsed = parseDerivation(derivation);
if (!parsed.isRuntimeDependent && evaluationCache.has(key)) {
  evaluationStack.delete(key);
  return evaluationCache.get(key);
}

// ... evaluate ...

// Cache only if config-only
if (!parsed.isRuntimeDependent) {
  evaluationCache.set(key, value);
}
```

### 2. Server projection

`ServerProjection.derived` carries live formulas ONLY for runtime-dependent derivations. Config-only derivations are pre-resolved into `ServerProjection.values` as concrete values.

At server startup, the runtime evaluates `derived` formulas fresh on every `read()` call — no caching of their results.

### 3. Pre-evaluation during createCnos()

During `createCnos()` / `cnos.ready()`:
- Extract dependency graph from all derivations.
- Topological sort. Detect cycles.
- Pre-evaluate all **config-only** derivations and cache results.
- Leave **runtime-dependent** derivations unevaluated until first read.

### 4. Runtime namespace generalization

`process.*` is generalized to **runtime namespaces** — a category of read-only, live, mutable namespaces provided by the host process. See `cnos-derived-values.md` §2 for the full model. `process` is the built-in default. Users can declare custom runtime namespaces (`request.*`, `session.*`, `flags.*`) in the manifest and register providers via `cnos.registerRuntimeProvider()`.

All runtime namespaces follow the same caching rule: derivations that reference them are never cached.

### 5. Tests to verify

These tests MUST pass to confirm the contradiction is resolved:

- DRV-V-9: Config-only derivation cached across reads — evaluator called once for two reads.
- DRV-V-10: Runtime-dependent derivation NOT cached — two reads with changed `process.env` between them return different values.
- DRV-R-2: `process.env.PORT` changes → re-read returns new value.
- DRV-R-5: Custom runtime namespace re-read reflects provider change.
- DRV-PR-3: Server projection puts config-only derivations in `values` as concrete.
- DRV-PR-4: Server projection puts runtime-dependent in `derived` with formula.
- DRV-PR-5: Server runtime evaluates `derived` fresh on every read.

## Authority

`cnos-derived-values.md` §5 is the single source of truth for caching behavior. If any other document or code contradicts it, §5 wins. Do not modify the caching rule in §5 without explicit triage approval.
