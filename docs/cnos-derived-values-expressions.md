# CNOS — Derived Values and Safe Runtime Expressions

**Status:** Implementation-ready. Final.
**Scope:** `cnos` repo.

---

## 1. What This Adds

Authors can define config values computed from other config values and live runtime inputs, without writing application code.

```yaml
app:
  origin:
    $derive: "${value.app.protocol}://${value.app.host}:${value.app.port}"
```

`cnos.value("app.origin")` returns `"https://api.kitsy.ai:443"`, evaluated at read time.

---

## 2. Runtime Namespaces

### 2.1 The concept

CNOS has two categories of namespaces:

**Config namespaces** — values come from config files, env files, CLI args, vaults. They are resolved once during `createCnos()` / `cnos.ready()` and do not change between reads. Examples: `value.*`, `secret.*`, `meta.*`.

**Runtime namespaces** — values come from the live execution context. They are provided by the host process, can change between reads, and are never cached. Examples: `process.*`, and any user-defined runtime namespace.

### 2.2 Built-in runtime namespace: `process`

Always available in server context. Exposes `process.env.*`.

```yaml
app:
  port:
    $derive:
      expr: "coalesce(process.env.PORT, value.app.default_port, '3000')"
```

### 2.3 User-defined runtime namespaces

Declared in the manifest under `namespaces.runtime`:

```yaml
namespaces:
  runtime:
    request:
      description: "HTTP request context"
      server_only: true
    session:
      description: "User session context"
      server_only: true
    flags:
      description: "Live feature flag evaluations"
      server_only: false    # available in browser too (injected by app framework)
```

Runtime namespaces are never populated from config files. They are populated by the host application via a runtime provider API:

```ts
const cnos = await createCnos();

// Register runtime namespace providers
cnos.registerRuntimeProvider("request", (key: string) => {
  // Called on every read of a request.*-dependent derivation
  return currentRequest?.headers?.[key];
});

cnos.registerRuntimeProvider("session", (key: string) => {
  return currentSession?.get(key);
});

// Now derivations that reference request.* or session.* work
cnos.value("app.greeting");
// $derive: "concat('Hello ', coalesce(session.user_name, 'Guest'))"
// → "Hello Prashant"
```

### 2.4 `process` is just the default runtime namespace

`process` is pre-registered with a built-in provider that reads `process.env`. It is not special-cased in the evaluator — it follows the same runtime namespace contract as user-defined ones.

```ts
// This is what CNOS does internally at startup:
cnos.registerRuntimeProvider("process", (key: string) => {
  // key is "env.PORT" when the expression says process.env.PORT
  const segments = key.split(".");
  if (segments[0] === "env") {
    return process.env[segments.slice(1).join(".")];
  }
  return undefined;
});
```

### 2.5 Properties of runtime namespaces

| Property | Config namespaces | Runtime namespaces |
|----------|------------------|-------------------|
| Source | Files, env files, vaults, CLI | Host process / app framework |
| Populated by | CNOS loaders | `registerRuntimeProvider()` |
| Resolved when | `createCnos()` / `cnos.ready()` | Every read (live) |
| Cacheable | Yes (within resolution pass) | **No — never cached** |
| Available at build time | Yes | Only if provider is registered during build |
| Writable via CLI | Yes (`cnos value set`) | No (read-only) |
| Promotable to browser | Yes | Only if `server_only: false` in declaration |

---

## 3. Authoring Model

### 3.1 Two syntaxes

**Template shorthand** (80% of cases):

```yaml
app:
  origin:
    $derive: "${value.app.protocol}://${value.app.host}:${value.app.port}"
```

**Expression syntax** (conditionals, logic):

```yaml
app:
  origin:
    $derive:
      expr: "concat(value.app.protocol, '://', value.app.host, when(value.app.port, concat(':', value.app.port), ''))"
```

### 3.2 Detection

```ts
interface DerivedValue {
  $derive: string | { expr: string };
}
```

String → template. Object with `expr` → expression.

### 3.3 Authoring rules

| Rule | Detail |
|------|--------|
| Allowed target namespaces | `value.*`, custom writable data namespaces |
| Forbidden target namespaces | `public.*`, `meta.*`, `secret.*`, any runtime namespace |
| Allowed references in expressions | `value.*`, `meta.*`, custom shareable data namespaces, any declared runtime namespace |
| Forbidden references | `secret.*`, `public.*` |

---

## 4. Expression Language

### 4.1 Built-in functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `concat(a, b, ...)` | `(...args) → string` | Concatenate. Nulls → empty string. |
| `coalesce(a, b, ...)` | `(...args) → any` | First non-null, non-undefined. |
| `when(cond, then, else)` | `(any, any, any) → any` | Conditional. |
| `exists(ref)` | `(any) → boolean` | True if non-null/undefined. |
| `eq(a, b)` | `(any, any) → boolean` | Strict equality. |
| `ne(a, b)` | `(any, any) → boolean` | Strict inequality. |

### 4.2 Template parsing

`"${value.app.host}:${value.app.port}"` → `concat(value.app.host, ':', value.app.port)`

Rules: `${...}` contains a single ref. No nested expressions. No function calls inside templates.

### 4.3 What is NOT in the language

No arithmetic, no comparison operators, no logical operators, no string methods, no arrays, no JavaScript, no import/require/eval, no network/filesystem/time/random.

---

## 5. Evaluation Model and Caching

### 5.1 The caching rule

This is the single source of truth for caching behavior. There is no other caching rule anywhere in the system.

| Derivation type | How to detect | Caching behavior |
|-----------------|---------------|-----------------|
| **Config-only** — all dependencies are config namespaces (`value.*`, `meta.*`, custom data) | No runtime namespace refs in dependency tree | **Cached once per resolution pass.** Same result on every read until the next `createCnos()` or `cnos.ready()`. |
| **Runtime-dependent** — any dependency (direct or transitive) is a runtime namespace (`process.*`, `request.*`, `session.*`, or any user-defined runtime namespace) | At least one runtime namespace ref in dependency tree | **Never cached. Evaluated fresh on every read.** Result may differ between consecutive reads. |

### 5.2 Why this rule

Config-only derivations are deterministic — their inputs don't change between reads. Caching them avoids redundant computation (especially for derivations that other derivations depend on).

Runtime-dependent derivations are non-deterministic — `process.env.PORT` can change, `request.headers.host` changes per request, `session.user_name` changes per user. Caching would serve stale data. They must always be live.

### 5.3 Evaluation algorithm

```ts
function evaluateDerived(
  key: string,
  derivation: DerivedValue,
  graph: ResolvedGraph,
  runtimeProviders: Map<string, RuntimeProvider>,
  evaluationCache: Map<string, unknown>,
  evaluationStack: Set<string>,
): unknown {
  // Cycle detection
  if (evaluationStack.has(key)) {
    const chain = [...evaluationStack, key].join(" → ");
    throw new CnosDerivedCycleError(`Derivation cycle: ${chain}`);
  }
  evaluationStack.add(key);

  // Cache check — ONLY for non-runtime-dependent derivations
  const parsed = parseDerivation(derivation);
  if (!parsed.isRuntimeDependent && evaluationCache.has(key)) {
    evaluationStack.delete(key);
    return evaluationCache.get(key);
  }

  // Evaluate
  const value = evalAST(parsed.ast, {
    resolve: (ref: string) => {
      const nsRoot = ref.split(".")[0];

      // Runtime namespace → call provider, never cache
      if (runtimeProviders.has(nsRoot)) {
        const provider = runtimeProviders.get(nsRoot)!;
        const subKey = ref.slice(nsRoot.length + 1);
        return provider(subKey);
      }

      // Config namespace → read from graph
      const entry = graph.entries.get(ref);
      if (!entry) return undefined;
      if (isDerivedValue(entry.value)) {
        return evaluateDerived(ref, entry.value, graph, runtimeProviders, evaluationCache, evaluationStack);
      }
      return entry.value;
    },
  });

  // Cache only if config-only
  if (!parsed.isRuntimeDependent) {
    evaluationCache.set(key, value);
  }

  evaluationStack.delete(key);
  return value;
}
```

### 5.4 Dependency resolution order

Before any reads, during `createCnos()`:

1. Extract dependency graph from all derivation expressions in the resolved graph.
2. Topological sort.
3. Detect cycles. If found → throw `CnosDerivedCycleError` with full chain.
4. Pre-evaluate all config-only derivations and cache results.
5. Runtime-dependent derivations are left unevaluated until first read.

### 5.5 Runtime-dependent detection

```ts
function isRuntimeDependent(
  derivation: ParsedDerivation,
  graph: ResolvedGraph,
  runtimeNamespaces: Set<string>,
): boolean {
  for (const ref of derivation.refs) {
    const nsRoot = ref.split(".")[0];
    if (runtimeNamespaces.has(nsRoot)) return true;
    // Check transitive dependencies
    const entry = graph.entries.get(ref);
    if (entry && isDerivedValue(entry.value)) {
      const depParsed = parseDerivation(entry.value);
      if (isRuntimeDependent(depParsed, graph, runtimeNamespaces)) return true;
    }
  }
  return false;
}
```

---

## 6. Runtime Provider API

### 6.1 Interface

```ts
/**
 * A function that resolves a key within a runtime namespace.
 * Called on every read of a runtime-dependent derivation.
 * Must be synchronous (derivation evaluation is synchronous).
 */
type RuntimeProvider = (key: string) => unknown;

interface CnosRuntime {
  // ... existing methods ...

  /**
   * Register a provider for a runtime namespace.
   * The namespace must be declared in manifest under namespaces.runtime.
   * "process" is pre-registered and cannot be overridden.
   */
  registerRuntimeProvider(namespace: string, provider: RuntimeProvider): void;
}
```

### 6.2 Usage example

```ts
import { createCnos } from "@kitsy/cnos";
import { getCurrentRequest } from "./http-context";

const cnos = await createCnos();

// Register request context (called per-request in middleware)
cnos.registerRuntimeProvider("request", (key) => {
  const req = getCurrentRequest();
  if (key.startsWith("headers.")) return req?.headers?.[key.slice(8)];
  if (key === "method") return req?.method;
  if (key === "url") return req?.url;
  return undefined;
});

// Now this derivation works:
// value.app.current_host:
//   $derive:
//     expr: "coalesce(request.headers.host, value.app.default_host)"
const host = cnos.value("app.current_host"); // live per-request
```

### 6.3 Constraints

- Runtime providers must be **synchronous**. No async. Derivation evaluation is synchronous because `cnos.read()` / `cnos.value()` are synchronous APIs.
- Providers must be **idempotent within a single call** — calling the provider twice for the same key in the same derivation evaluation must return the same value.
- Providers must not have side effects.
- Unregistered runtime namespace refs → `undefined` (not an error, because the provider might be registered later in the app lifecycle).

---

## 7. Projection Behavior

### 7.1 Browser / public projections

**Always emit concrete values.** Never formulas.

If a promoted derived key is runtime-dependent:
- If the runtime namespace has `server_only: true` → **build error**.
- If the runtime namespace has `server_only: false` AND a provider is registered during build → **resolve and emit concrete value**.
- If the runtime namespace has `server_only: false` BUT no provider during build → **build error**.

```bash
cnos build browser
# Error: Cannot build browser projection: value.app.greeting depends on
# session.user_name (runtime namespace "session" is server_only).
```

### 7.2 Server projection

Server projections partition derived values:

```ts
interface ServerProjection {
  version: 1;
  workspace: string;
  profile: string;
  resolvedAt: string;
  configHash: string;

  values: Record<string, unknown>;          // concrete values (including resolved config-only derivations)
  derived: Record<string, DerivedFormula>;   // live derivations (runtime-dependent only)
  secretRefs: Record<string, SecretRef>;
  publicKeys: string[];

  runtimeNamespaces: string[];              // which runtime namespaces are needed by derived formulas

  meta: { workspace: string; profile: string; cnos_version: string };
}

interface DerivedFormula {
  expr: string;
  deps: string[];              // config keys this depends on (already in values)
  runtimeRefs: string[];       // runtime namespace refs (e.g., ["process.env.PORT", "request.headers.host"])
}
```

At server startup:
1. Concrete `values` → immediately readable.
2. `derived` formulas → evaluated on every read against `values` + registered runtime providers.
3. The runtime checks that all namespaces in `runtimeNamespaces` have registered providers. Missing provider → warning (not error, because it may be registered later).

### 7.3 Env projection

All derivations resolved to concrete values at build time. Runtime-dependent derivations with unresolvable refs → skipped with warning.

---

## 8. Promotion Safety

Transitive dependency check applies to all namespaces:

```
For each dependency of a promoted derived value:
  If dependency namespace is secret.* → REJECT
  If dependency namespace is sensitive custom → REJECT
  If dependency is a runtime namespace with server_only: true → REJECT for browser/public
  If dependency is another derived value → recursively check ITS dependencies
```

---

## 9. CLI Surface

### 9.1 Writing

```bash
# Template
cnos value set app.origin --derive '${value.app.protocol}://${value.app.host}'

# Expression
cnos value set app.display --derive --expr "coalesce(value.app.custom_name, value.app.name, 'Unnamed')"

# Normal value (unchanged)
cnos value set app.host api.kitsy.ai
```

### 9.2 Write-time validation

1. Syntax check → invalid → error with position.
2. Namespace check → `secret.*` or `public.*` ref → error.
3. Target namespace check → `meta.*`, `public.*`, runtime namespace → error.

### 9.3 Reading

```bash
cnos read value.app.origin
# https://api.kitsy.ai:443

cnos list values
# app.host     = api.kitsy.ai
# app.origin   = https://api.kitsy.ai:443  (derived)
```

### 9.4 Inspect

```bash
cnos inspect value.app.origin
# Key:        value.app.origin
# Value:      https://api.kitsy.ai:443
# Type:       derived
# Expression: ${value.app.protocol}://${value.app.host}:${value.app.port}
# Dependencies:
#   value.app.protocol = "https"
#   value.app.host     = "api.kitsy.ai"
#   value.app.port     = 443
# Runtime-dependent: no

cnos inspect value.app.effective_port
# Key:        value.app.effective_port
# Value:      8080  (live)
# Type:       derived
# Expression: coalesce(process.env.PORT, value.app.default_port, '3000')
# Dependencies:
#   process.env.PORT       = "8080"  (runtime: process)
#   value.app.default_port = 3000
# Runtime-dependent: yes (process)
# ⚠ Cannot be promoted to browser/public
```

---

## 10. Schema Validation

Validates the **resolved value**, not the `$derive` object.

- Config-only derivation → resolve, then validate type/required/enum/pattern.
- Runtime-dependent derivation → skip validation with warning: "Cannot validate value.app.effective_port — depends on runtime namespace process."

---

## 11. Internal Types

```ts
interface DerivedValue {
  $derive: string | { expr: string };
}

interface ParsedDerivation {
  type: "template" | "expression";
  raw: string;
  ast: ExprNode;
  refs: string[];                    // all referenced keys
  runtimeRefs: string[];             // subset from runtime namespaces
  isRuntimeDependent: boolean;       // true if runtimeRefs.length > 0
}

type ExprNode =
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "ref"; path: string }
  | { type: "call"; name: string; args: ExprNode[] };
```

---

## 12. Module Layout

```
packages/cnos/src/
  derive/
    types.ts                    # DerivedValue, ParsedDerivation, ExprNode
    parser.ts                   # expression → AST
    templateParser.ts           # template → AST
    evaluator.ts                # AST + graph + providers → value
    depGraph.ts                 # dependency extraction, topo sort, cycle detection
    builtins.ts                 # concat, coalesce, when, exists, eq, ne
    validate.ts                 # namespace checks, syntax validation
  runtime/
    runtimeProviders.ts         # provider registry, process.* default provider
  orchestrator/
    runtime.ts                  # UPDATED: intercept derived values, call evaluator
  projection/
    serverProjection.ts         # UPDATED: partition config-only vs runtime-dependent
  exporters/
    toEnv.ts                    # UPDATED: resolve derivations
    toPublicEnv.ts              # UPDATED: resolve, reject runtime-dependent

packages/cli/src/
  commands/
    value.ts                    # UPDATED: --derive flag
    inspect.ts                  # UPDATED: derived metadata
    list.ts                     # UPDATED: (derived) annotation
```

---

## 13. Test Plan

### Authoring (DRV-A)

- [ ] DRV-A-1: Template stored as structured YAML.
- [ ] DRV-A-2: Expression stored correctly.
- [ ] DRV-A-3: CLI `--derive '<template>'` writes correct YAML.
- [ ] DRV-A-4: CLI `--derive --expr '<expr>'` writes correct YAML.
- [ ] DRV-A-5: Derivation under `secret.*` → rejected.
- [ ] DRV-A-6: Derivation under `meta.*` → rejected.
- [ ] DRV-A-7: Derivation under `public.*` → rejected.
- [ ] DRV-A-8: Derivation under runtime namespace → rejected.
- [ ] DRV-A-9: Derivation referencing `secret.*` → rejected.
- [ ] DRV-A-10: Derivation referencing `public.*` → rejected.
- [ ] DRV-A-11: Invalid syntax → rejected with position info.

### Template parsing (DRV-T)

- [ ] DRV-T-1: `"${value.x}"` → value of x.
- [ ] DRV-T-2: `"hello ${value.name}"` → `"hello <name>"`.
- [ ] DRV-T-3: `"${value.a}://${value.b}:${value.c}"` → correct.
- [ ] DRV-T-4: No `${...}` → literal string, not derivation.
- [ ] DRV-T-5: Unclosed `${...` → parse error.
- [ ] DRV-T-6: Empty template → literal empty string.
- [ ] DRV-T-7: Nested `${...}` → parse error.

### Expression parsing (DRV-E)

- [ ] DRV-E-1: `concat('a', 'b')` → `"ab"`.
- [ ] DRV-E-2: `coalesce(null, 'fallback')` → `"fallback"`.
- [ ] DRV-E-3: `coalesce(value.x, 'default')` where x exists → x's value.
- [ ] DRV-E-4: `coalesce(value.x, 'default')` where x undefined → `"default"`.
- [ ] DRV-E-5: `when(true, 'yes', 'no')` → `"yes"`.
- [ ] DRV-E-6: `when(false, 'yes', 'no')` → `"no"`.
- [ ] DRV-E-7: `exists(value.x)` where x exists → `true`.
- [ ] DRV-E-8: `exists(value.x)` where x missing → `false`.
- [ ] DRV-E-9: `eq('a', 'a')` → `true`.
- [ ] DRV-E-10: `ne('a', 'b')` → `true`.
- [ ] DRV-E-11: Nested: `concat('x', when(true, 'y', 'z'))` → `"xy"`.
- [ ] DRV-E-12: Literals: string, number, boolean, null all parse.

### Evaluation + Caching (DRV-V)

- [ ] DRV-V-1: Simple derived value resolves at read time.
- [ ] DRV-V-2: Derived depending on derived → correct order.
- [ ] DRV-V-3: Three-level chain resolves.
- [ ] DRV-V-4: Cycle (a → b → a) → `CnosDerivedCycleError` with chain.
- [ ] DRV-V-5: Self-reference → cycle error.
- [ ] DRV-V-6: Diamond (a → b → d, a → c → d) → d evaluated once.
- [ ] DRV-V-7: Missing ref: `read()` → undefined. `require()` → error.
- [ ] DRV-V-8: `readOr()` with failing derivation → fallback.
- [ ] DRV-V-9: **Config-only derivation cached across reads.** Two consecutive `read()` calls return same value, evaluator called once.
- [ ] DRV-V-10: **Runtime-dependent derivation NOT cached.** Two consecutive reads with changed `process.env` between them return different values.
- [ ] DRV-V-11: Config-only derivation with diamond dep → cache hit on shared dep, single evaluation.

### Runtime namespaces (DRV-R)

- [ ] DRV-R-1: `process.env.PORT` resolves from `process.env`.
- [ ] DRV-R-2: `process.env.PORT` changes → re-read returns new value.
- [ ] DRV-R-3: Unset `process.env.MISSING` → undefined.
- [ ] DRV-R-4: Custom runtime namespace `request.headers.host` resolves from provider.
- [ ] DRV-R-5: Custom runtime namespace re-read reflects provider change.
- [ ] DRV-R-6: Unregistered runtime namespace → undefined (not error).
- [ ] DRV-R-7: Transitive runtime dependency detected (a → b → process.env.X).
- [ ] DRV-R-8: `registerRuntimeProvider()` for undeclared namespace → error.
- [ ] DRV-R-9: `registerRuntimeProvider("process", ...)` → error (built-in, not overridable).

### Projections (DRV-PR)

- [ ] DRV-PR-1: Browser → all derivations concrete.
- [ ] DRV-PR-2: Browser with runtime-dependent (`server_only: true`) promoted key → build error.
- [ ] DRV-PR-3: Server → config-only derivations in `values` as concrete.
- [ ] DRV-PR-4: Server → runtime-dependent derivations in `derived` with formula.
- [ ] DRV-PR-5: Server runtime evaluates `derived` against `values` + providers.
- [ ] DRV-PR-6: Env export resolves config-only derivations.
- [ ] DRV-PR-7: Env export skips unresolvable runtime-dependent with warning.
- [ ] DRV-PR-8: `runtimeNamespaces` in projection lists needed namespaces.

### Promotion safety (DRV-S)

- [ ] DRV-S-1: Promote derived with only `value.*` deps → OK.
- [ ] DRV-S-2: Promote derived with `process.*` dep → rejected.
- [ ] DRV-S-3: Promote derived with transitive `secret.*` dep → rejected.
- [ ] DRV-S-4: Promote derived with `server_only` runtime dep → rejected for browser.
- [ ] DRV-S-5: Promote derived with `server_only: false` runtime dep + provider at build → OK.

### Schema (DRV-SC)

- [ ] DRV-SC-1: Validates resolved value, not `$derive` object.
- [ ] DRV-SC-2: Type mismatch in resolved → error.
- [ ] DRV-SC-3: Runtime-dependent → validation skipped with warning.

### CLI (DRV-CL)

- [ ] DRV-CL-1: `list` shows `(derived)` annotation.
- [ ] DRV-CL-2: `inspect` shows expression, deps, resolved value.
- [ ] DRV-CL-3: `inspect` for runtime-dependent shows namespaces and promotion warning.
- [ ] DRV-CL-4: `read` resolves transparently.
- [ ] DRV-CL-5: `export env` resolves derivations.

### Edge cases (DRV-ED)

- [ ] DRV-ED-1: Derived → number type preserved.
- [ ] DRV-ED-2: Derived → boolean type preserved.
- [ ] DRV-ED-3: Derived → null returned.
- [ ] DRV-ED-4: Derived ref overridden by CLI arg → uses CLI value.
- [ ] DRV-ED-5: Derived in profile-specific file → profile override works.
- [ ] DRV-ED-6: Concrete value at higher precedence overrides derivation completely.
- [ ] DRV-ED-7: 50 derivations in chain → no stack overflow.
- [ ] DRV-ED-8: Unicode in template: `"${value.greeting} 世界"`.
- [ ] DRV-ED-9: Nested calls 5 levels deep → correct.
- [ ] DRV-ED-10: Derivation in workspace A, dep in workspace B (inherited) → cross-workspace.
