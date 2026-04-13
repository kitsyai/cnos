# CNOS — Derived Values and Safe Runtime Expressions

**Status:** Implementation-ready.
**Scope:** `cnos` repo. Adds derived value support to the config authoring model, runtime, CLI, and projection pipeline.

---

## 1. What This Adds

Authors can define config values that are computed from other config values, without writing application code.

```yaml
# Before: developer computes origin in app code
# const origin = `${config.protocol}://${config.host}:${config.port}`

# After: CNOS computes it from config
app:
  protocol: https
  host: api.kitsy.ai
  port: 443
  origin:
    $derive: "${value.app.protocol}://${value.app.host}:${value.app.port}"
```

The result: `cnos.value("app.origin")` returns `"https://api.kitsy.ai:443"`. The derivation is evaluated at read time against the resolved graph. It works in CLI, runtime, build outputs, and projections.

---

## 2. Authoring Model

### 2.1 Two syntaxes for `$derive`

**Template shorthand** — for simple interpolation (80% of cases):

```yaml
app:
  origin:
    $derive: "${value.app.protocol}://${value.app.host}:${value.app.port}"
```

Template strings use `${ref}` syntax. The parser converts them to `concat(...)` calls internally. No conditionals, no logic — just interpolation.

**Expression syntax** — for conditionals and logic (20% of cases):

```yaml
app:
  origin:
    $derive:
      expr: "concat(value.app.protocol, '://', value.app.host, when(value.app.port, concat(':', value.app.port), ''))"

  display_name:
    $derive:
      expr: "coalesce(value.app.custom_name, value.app.name, 'Unnamed App')"

  debug_enabled:
    $derive:
      expr: "eq(value.app.env, 'development')"
```

### 2.2 Detection

A value is a derivation when its YAML value is an object with a `$derive` key:

```ts
function isDerivedValue(value: unknown): value is DerivedValue {
  return typeof value === "object" && value !== null && "$derive" in value;
}

interface DerivedValue {
  $derive: string | { expr: string };
}
```

If `$derive` is a string, it's a template. If `$derive` is an object with `expr`, it's an expression.

### 2.3 Authoring rules

| Rule | Enforcement |
|------|-------------|
| Derived values can live in writable data namespaces only (`value.*`, custom data namespaces) | Write-time validation |
| Cannot author under `public.*` (public is a projection) | Write-time rejection |
| Cannot author under `meta.*` (meta is system-populated) | Write-time rejection |
| Cannot author under `secret.*` (secrets come from vaults) | Write-time rejection |
| Expressions may reference: `value.*`, custom shareable namespaces, `meta.*`, `process.*` | Parse-time validation |
| Expressions may NOT reference: `secret.*`, `public.*` | Parse-time rejection |

---

## 3. Expression Language

### 3.1 Grammar

```
expression   := literal | ref | call
literal      := string | number | boolean | null
string       := "'" chars "'"
number       := digit+ ("." digit+)?
boolean      := "true" | "false"
null         := "null"
ref          := namespace "." path    // value.app.host, process.env.PORT, meta.profile
call         := name "(" args ")"
args         := expression ("," expression)*
name         := "concat" | "coalesce" | "when" | "exists" | "eq" | "ne"
```

### 3.2 Built-in functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `concat(a, b, ...)` | `(...args: any[]) → string` | Concatenate all arguments as strings. Nulls become empty string. |
| `coalesce(a, b, ...)` | `(...args: any[]) → any` | Return first non-null, non-undefined argument. |
| `when(condition, then, else)` | `(cond: any, then: any, else: any) → any` | If `condition` is truthy, return `then`, else return `else`. |
| `exists(ref)` | `(ref: any) → boolean` | True if the referenced key exists and is not null/undefined. |
| `eq(a, b)` | `(a: any, b: any) → boolean` | Strict equality (`===`). |
| `ne(a, b)` | `(a: any, b: any) → boolean` | Strict inequality (`!==`). |

### 3.3 Template shorthand parsing

Template strings are syntactic sugar over `concat`:

```
"${value.app.protocol}://${value.app.host}:${value.app.port}"
```

Parses to:

```
concat(value.app.protocol, '://', value.app.host, ':', value.app.port)
```

Rules:
- `${...}` contains a single ref (no nested expressions inside templates).
- Everything outside `${...}` is a string literal.
- Templates cannot contain function calls — use `expr` syntax for that.
- Empty template `""` is a literal empty string, not a derivation.

### 3.4 What is NOT in the expression language

- No arithmetic (`+`, `-`, `*`, `/`)
- No comparison operators (`>`, `<`, `>=`, `<=`)
- No logical operators (`&&`, `||`, `!`)
- No string methods (`.length`, `.toUpperCase()`)
- No array operations
- No arbitrary JavaScript
- No `import`, `require`, `eval`, `Function`
- No network/filesystem/time/random access

This is intentional. The expression language is for value composition and conditional selection, not for computation. If you need computation, do it in application code and store the result as a regular CNOS value.

---

## 4. Evaluation Model

### 4.1 When evaluation happens

Derived values are evaluated **at read time**, not at resolution time. This means:

- The resolved graph stores `DerivedValue` objects, not concrete values.
- When `cnos.read("value.app.origin")` is called, the evaluator runs the expression against the current graph snapshot.
- If the expression references `process.env.PORT`, the value changes when `PORT` changes — it's live.

### 4.2 Dependency resolution

Derived values can depend on other derived values:

```yaml
app:
  base_url:
    $derive: "${value.app.protocol}://${value.app.host}"
  api_url:
    $derive: "${value.app.base_url}/api/v1"
```

The evaluator resolves dependencies in topological order:

```
1. Extract dependency graph from all derivation expressions.
2. Topological sort.
3. Detect cycles BEFORE any evaluation.
4. If cycle found: throw CnosDerivedCycleError with the full dependency chain.
5. Evaluate in topological order: leaves first, then dependents.
6. Cache resolved values for the current read pass.
```

### 4.3 Evaluation algorithm

```ts
function evaluateDerived(
  key: string,
  derivation: DerivedValue,
  graph: ResolvedGraph,
  evaluationCache: Map<string, unknown>,
  evaluationStack: Set<string>,  // for cycle detection
): unknown {
  // Cycle detection
  if (evaluationStack.has(key)) {
    const chain = [...evaluationStack, key].join(" → ");
    throw new CnosDerivedCycleError(`Derivation cycle detected: ${chain}`);
  }
  evaluationStack.add(key);

  // Check cache (already evaluated in this read pass)
  if (evaluationCache.has(key)) {
    evaluationStack.delete(key);
    return evaluationCache.get(key);
  }

  // Parse expression
  const ast = parseExpression(derivation);

  // Evaluate
  const value = evalAST(ast, {
    resolve: (ref: string) => {
      // ref is like "value.app.host" or "process.env.PORT"
      if (ref.startsWith("process.")) {
        return resolveProcessRef(ref);
      }
      const entry = graph.entries.get(ref);
      if (!entry) return undefined;
      if (isDerivedValue(entry.value)) {
        // Recursively evaluate dependent derivation
        return evaluateDerived(ref, entry.value, graph, evaluationCache, evaluationStack);
      }
      return entry.value;
    },
  });

  evaluationCache.set(key, value);
  evaluationStack.delete(key);
  return value;
}
```

### 4.4 Determinism rules

- No side effects.
- No network, filesystem, or module access.
- Repeated reads of a derived value return the same result if inputs haven't changed.
- `process.*` references are the only source of non-determinism — they read from the live process environment.
- The expression language has no random, time, or counter functions.

---

## 5. `process.*` Namespace Rules

`process.*` is a read-only virtual namespace that exposes runtime process state. In v1, it exposes only `process.env.*`.

### 5.1 Reference syntax

```yaml
app:
  port:
    $derive:
      expr: "coalesce(process.env.PORT, value.app.default_port, '3000')"
```

`process.env.PORT` resolves to `process.env["PORT"]` at read time.

### 5.2 Constraints

| Rule | Rationale |
|------|-----------|
| `process.*` refs allowed in server-context derivations only | Browser has no `process.env` |
| A derived key that references `process.*` **cannot** be promoted to public | Browser projection must be concrete at build time |
| A derived key that references `process.*` **cannot** appear in browser projection | Same reason |
| `cnos build server` preserves `process.*` derivations as formulas in the projection | Server projection evaluates at runtime |
| `cnos build browser` / `cnos build public` resolve all derivations to concrete values — `process.*` derivations that couldn't be resolved at build time cause a build error | Build must be deterministic |
| `cnos validate` skips type-checking for `process.*`-dependent derivations (value unknown until runtime) | Can't validate what doesn't exist yet |
| `cnos inspect` shows "depends on runtime: process.env.PORT" for such keys | Developer visibility |

### 5.3 Detection

A derivation is `process.*`-dependent if its expression AST (recursively, through dependent derivations) references any `process.*` key.

```ts
function isProcessDependent(derivation: DerivedValue, graph: ResolvedGraph): boolean {
  const deps = extractAllRefs(derivation);
  for (const dep of deps) {
    if (dep.startsWith("process.")) return true;
    const entry = graph.entries.get(dep);
    if (entry && isDerivedValue(entry.value)) {
      if (isProcessDependent(entry.value, graph)) return true;
    }
  }
  return false;
}
```

---

## 6. Projection Behavior

### 6.1 Browser / public projections

**Always emit concrete values.** The browser runtime receives resolved values, never formulas.

```yaml
# Config
app:
  origin:
    $derive: "${value.app.protocol}://${value.app.host}"
  protocol: https
  host: api.kitsy.ai

# public.promote includes value.app.origin
```

Browser projection output:
```json
{ "public.app.origin": "https://api.kitsy.ai" }
```

If a promoted derived key depends on `process.*`, `cnos build browser` / `cnos build public` throws:

```
Error: Cannot build browser projection: value.app.port depends on process.env.PORT
which is not available at build time. Remove the process.* dependency or remove
this key from public.promote.
```

### 6.2 Server projection

Server projections carry derivation formulas for `process.*`-dependent keys. All other derived values are resolved to concrete values at build time.

```ts
interface ServerProjection {
  version: 1;
  workspace: string;
  profile: string;
  resolvedAt: string;
  configHash: string;

  values: Record<string, unknown>;       // concrete resolved values (including resolved derivations)
  derived: Record<string, DerivedFormula>; // live derivations (process.*-dependent only)
  secretRefs: Record<string, SecretRef>;
  publicKeys: string[];

  meta: { workspace: string; profile: string; cnos_version: string };
}

interface DerivedFormula {
  expr: string;               // the expression
  deps: string[];             // dependency keys
  processRefs: string[];      // process.* refs used
}
```

At server startup, the runtime:
1. Loads the projection.
2. Concrete `values` are immediately readable.
3. `derived` entries are evaluated against the projection's `values` + live `process.env`.
4. Results are cached for the lifetime of the runtime instance.

### 6.3 Env projection

`cnos build env` resolves all derivations to concrete values. If a derived key depends on `process.*` and the referenced env var exists at build time, it resolves. If not, the key is skipped with a warning:

```
Warning: Skipping value.app.port in env export — depends on process.env.PORT
which is not set. Set PORT in your environment or use cnos run to inject at runtime.
```

---

## 7. CLI Surface

### 7.1 Writing derived values

```bash
# Template shorthand
cnos value set app.origin --derive '${value.app.protocol}://${value.app.host}'

# Expression syntax
cnos value set app.display_name --derive --expr "coalesce(value.app.custom_name, value.app.name, 'Unnamed')"

# Normal value (unchanged)
cnos value set app.host api.kitsy.ai
```

`--derive` triggers derivation mode. Without it, the value is stored as a literal.

`--derive '<template>'` stores a template derivation.
`--derive --expr '<expression>'` stores an expression derivation.

### 7.2 Write-time validation

When `--derive` is used, CNOS validates before writing:

1. **Syntax check:** Parse the expression/template. Invalid syntax → error with position indicator.
2. **Namespace check:** All referenced namespaces must be allowed. `secret.*` or `public.*` ref → error.
3. **Namespace writability:** Target must be a writable data namespace. `meta.*`, `public.*` → error.

```bash
cnos value set app.leaked --derive '${secret.db.password}'
# Error: Derived expressions cannot reference secret.* keys.

cnos value set app.x --derive '${invalid syntax'
# Error: Invalid derivation template: unclosed ${...} at position 24.
```

### 7.3 Reading derived values

All read commands resolve derivations transparently:

```bash
cnos read value.app.origin
# https://api.kitsy.ai:443

cnos value get app.origin
# https://api.kitsy.ai:443

cnos list values
# app.host         = api.kitsy.ai
# app.port         = 443
# app.protocol     = https
# app.origin       = https://api.kitsy.ai:443  (derived)
```

The `(derived)` annotation in `list` output tells the developer this value is computed.

### 7.4 Inspecting derived values

```bash
cnos inspect value.app.origin
# Key:        value.app.origin
# Value:      https://api.kitsy.ai:443
# Namespace:  value
# Type:       derived
# Expression: ${value.app.protocol}://${value.app.host}:${value.app.port}
# Depends on:
#   value.app.protocol = "https"     (from: values/local/app.yml)
#   value.app.host     = "api.kitsy.ai" (from: values/local/app.yml)
#   value.app.port     = 443        (from: values/local/app.yml)
# Process-dependent: no
```

For `process.*`-dependent derivations:

```bash
cnos inspect value.app.effective_port
# Key:        value.app.effective_port
# Value:      8080  (current process.env.PORT)
# Type:       derived
# Expression: coalesce(process.env.PORT, value.app.default_port, '3000')
# Depends on:
#   process.env.PORT       = "8080"  (live runtime)
#   value.app.default_port = 3000    (from: values/local/app.yml)
# Process-dependent: yes
# ⚠ Cannot be promoted to public/browser
```

---

## 8. Schema Validation

Schema validation runs against the **resolved value** of a derivation, not the raw `$derive` object.

```yaml
# Schema
schema:
  value.app.origin:
    type: string
    required: true
    pattern: "^https?://"
```

At validation time:
1. Evaluate the derivation.
2. Type-check the result against the schema rule.
3. If the derivation depends on `process.*` and the process ref isn't available → skip validation for this key with a warning.

---

## 9. Promotion Safety

Derived values follow the same promotion rules as regular values, with additional transitive checks.

### 9.1 Transitive dependency check for promotion

When a derived key is in `public.promote`, CNOS checks ALL dependencies transitively:

```
For each dependency of the derived value:
  If dependency namespace is secret.* → REJECT
  If dependency namespace is sensitive custom → REJECT
  If dependency is process.* → REJECT (browser has no process.env)
  If dependency is another derived value → recursively check ITS dependencies
```

```bash
# This is OK: all deps are value.*
cnos promote value.app.origin --to public

# This fails: depends on process.*
cnos promote value.app.effective_port --to public
# Error: Cannot promote value.app.effective_port — depends on process.env.PORT
# (process.* is not available in browser context)
```

---

## 10. Internal Types

```ts
interface DerivedValue {
  $derive: string | { expr: string };
}

interface ParsedDerivation {
  type: "template" | "expression";
  raw: string;                    // original string
  ast: ExprNode;                  // parsed AST
  refs: string[];                 // all referenced keys (extracted from AST)
  processRefs: string[];          // subset that are process.* refs
  isProcessDependent: boolean;    // true if any ref is process.*
}

// AST nodes
type ExprNode =
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "ref"; path: string }      // "value.app.host"
  | { type: "call"; name: string; args: ExprNode[] };
```

---

## 11. Module Layout

```
packages/cnos/src/
  derive/
    types.ts                    # DerivedValue, ParsedDerivation, ExprNode
    parser.ts                   # expression string → AST
    templateParser.ts           # template string → AST (${...} → concat)
    evaluator.ts                # AST + graph snapshot → resolved value
    depGraph.ts                 # extract dependency graph, topological sort, cycle detection
    builtins.ts                 # concat, coalesce, when, exists, eq, ne implementations
    validate.ts                 # namespace checks, syntax validation
    processRefs.ts              # detect and resolve process.* references
  orchestrator/
    runtime.ts                  # UPDATED: intercept derived values in read/require/readOr
  projection/
    serverProjection.ts         # UPDATED: partition derived into concrete vs live formulas
  exporters/
    toEnv.ts                    # UPDATED: resolve derivations before export
    toPublicEnv.ts              # UPDATED: resolve derivations, reject process.*-dependent

packages/cli/src/
  commands/
    value.ts                    # UPDATED: --derive flag
    inspect.ts                  # UPDATED: derived metadata in output
    list.ts                     # UPDATED: (derived) annotation
```

---

## 12. Test Plan

### Authoring

- [ ] DRV-A-1: Template `$derive: "${value.x}"` stored as structured YAML.
- [ ] DRV-A-2: Expression `$derive: { expr: "..." }` stored correctly.
- [ ] DRV-A-3: `cnos value set x --derive '<template>'` writes correct YAML.
- [ ] DRV-A-4: `cnos value set x --derive --expr '<expr>'` writes correct YAML.
- [ ] DRV-A-5: Derivation under `secret.*` → rejected.
- [ ] DRV-A-6: Derivation under `meta.*` → rejected.
- [ ] DRV-A-7: Derivation under `public.*` → rejected.
- [ ] DRV-A-8: Derivation referencing `secret.*` → rejected at write time.
- [ ] DRV-A-9: Derivation referencing `public.*` → rejected.
- [ ] DRV-A-10: Invalid syntax → rejected with position info.

### Template parsing

- [ ] DRV-T-1: `"${value.x}"` → `concat(value.x)` → value of x.
- [ ] DRV-T-2: `"hello ${value.name}"` → `concat('hello ', value.name)`.
- [ ] DRV-T-3: `"${value.a}://${value.b}:${value.c}"` → correct concat.
- [ ] DRV-T-4: No `${...}` → treated as literal string, NOT a derivation.
- [ ] DRV-T-5: Unclosed `${...` → parse error.
- [ ] DRV-T-6: Empty template `""` → literal empty string.
- [ ] DRV-T-7: Nested `${...}` not allowed → parse error.

### Expression parsing

- [ ] DRV-E-1: `concat('a', 'b')` → `"ab"`.
- [ ] DRV-E-2: `coalesce(null, undefined, 'fallback')` → `"fallback"`.
- [ ] DRV-E-3: `coalesce(value.x, 'default')` where x exists → x's value.
- [ ] DRV-E-4: `coalesce(value.x, 'default')` where x is undefined → `"default"`.
- [ ] DRV-E-5: `when(true, 'yes', 'no')` → `"yes"`.
- [ ] DRV-E-6: `when(false, 'yes', 'no')` → `"no"`.
- [ ] DRV-E-7: `when(value.x, 'yes', 'no')` where x is truthy → `"yes"`.
- [ ] DRV-E-8: `when(value.x, 'yes', 'no')` where x is falsy → `"no"`.
- [ ] DRV-E-9: `exists(value.x)` where x exists → `true`.
- [ ] DRV-E-10: `exists(value.x)` where x doesn't exist → `false`.
- [ ] DRV-E-11: `eq('a', 'a')` → `true`.
- [ ] DRV-E-12: `eq('a', 'b')` → `false`.
- [ ] DRV-E-13: `ne('a', 'b')` → `true`.
- [ ] DRV-E-14: Nested calls: `concat('x', when(true, 'y', 'z'))` → `"xy"`.
- [ ] DRV-E-15: String literal with single quotes: `'hello world'`.
- [ ] DRV-E-16: Number literal: `42` → `42`.
- [ ] DRV-E-17: Boolean literal: `true` → `true`.
- [ ] DRV-E-18: Null literal: `null` → `null`.

### Evaluation

- [ ] DRV-V-1: Simple derived value resolves correctly at read time.
- [ ] DRV-V-2: Derived value depending on another derived value resolves in correct order.
- [ ] DRV-V-3: Three-level derivation chain resolves correctly.
- [ ] DRV-V-4: Cycle (a → b → a) detected → `CnosDerivedCycleError` with chain.
- [ ] DRV-V-5: Self-reference (a → a) detected → cycle error.
- [ ] DRV-V-6: Diamond dependency (a → b, a → c, b → d, c → d) resolves correctly, d evaluated once.
- [ ] DRV-V-7: Missing ref in derivation: `read()` returns undefined. `require()` throws `CnosDerivedResolutionError`.
- [ ] DRV-V-8: `readOr()` with failing derivation returns fallback.
- [ ] DRV-V-9: `concat()` with null arg → null becomes empty string.
- [ ] DRV-V-10: Evaluation cache prevents re-evaluation within same read pass.

### Process refs

- [ ] DRV-P-1: `process.env.PORT` resolves to `process.env["PORT"]`.
- [ ] DRV-P-2: `process.env.PORT` changes → re-read returns new value.
- [ ] DRV-P-3: `process.env.MISSING` → undefined.
- [ ] DRV-P-4: `coalesce(process.env.PORT, '3000')` with PORT unset → `"3000"`.
- [ ] DRV-P-5: Process-dependent derivation detected correctly.
- [ ] DRV-P-6: Transitive process dependency detected (a → b → process.env.X).

### Projections

- [ ] DRV-PR-1: Browser projection resolves all derivations to concrete values.
- [ ] DRV-PR-2: Browser projection with process-dependent promoted key → build error.
- [ ] DRV-PR-3: Server projection: non-process derivations → concrete in `values`.
- [ ] DRV-PR-4: Server projection: process-dependent derivations → in `derived` section with formula.
- [ ] DRV-PR-5: Server runtime evaluates `derived` formulas against `values` + live `process.env`.
- [ ] DRV-PR-6: Env export resolves derivations to concrete values.
- [ ] DRV-PR-7: Env export with unresolvable process ref → skip with warning.

### Promotion safety

- [ ] DRV-S-1: Promote derived value with only `value.*` deps → OK.
- [ ] DRV-S-2: Promote derived value with `process.*` dep → rejected.
- [ ] DRV-S-3: Promote derived value with transitive `secret.*` dep → rejected.
- [ ] DRV-S-4: Promote derived value with transitive `process.*` dep (a → b → process.env.X) → rejected.

### Schema

- [ ] DRV-SC-1: Schema validates resolved value, not `$derive` object.
- [ ] DRV-SC-2: Type mismatch in resolved derived value → validation error.
- [ ] DRV-SC-3: Process-dependent derivation → schema validation skipped with warning.

### CLI

- [ ] DRV-CL-1: `cnos list values` shows `(derived)` annotation.
- [ ] DRV-CL-2: `cnos inspect` shows expression, dependencies, resolved value.
- [ ] DRV-CL-3: `cnos inspect` for process-dependent shows warning about promotion.
- [ ] DRV-CL-4: `cnos read` resolves derived value transparently.
- [ ] DRV-CL-5: `cnos export env` resolves derived values in output.

### Edge cases

- [ ] DRV-ED-1: Derived value that resolves to a number → type preserved.
- [ ] DRV-ED-2: Derived value that resolves to a boolean → type preserved.
- [ ] DRV-ED-3: Derived value that resolves to null → null returned.
- [ ] DRV-ED-4: Derived value referencing a key overridden by CLI arg → uses CLI arg value.
- [ ] DRV-ED-5: Derived value in profile-specific file → profile override applies normally.
- [ ] DRV-ED-6: Derived value overridden by a concrete value in higher-precedence source → concrete wins, derivation ignored.
- [ ] DRV-ED-7: 50 derived values in dependency chain → resolves without stack overflow.
- [ ] DRV-ED-8: Template with unicode: `"${value.greeting} 世界"` → correct.
- [ ] DRV-ED-9: Expression with deeply nested calls (5 levels) → resolves correctly.
- [ ] DRV-ED-10: Derived value in workspace A, dependency in workspace B (inherited) → resolves across workspaces.
