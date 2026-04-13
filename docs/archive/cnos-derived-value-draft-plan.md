# CNOS Derived Values and Safe Runtime Expressions

## Summary
Add first-class **derived values** to CNOS so authors can define config like `value.app.origin` from other CNOS keys without inventing app-local config code.

The design should be:

- author derived values as **structured CNOS data**, not ad hoc JS
- expose a small **safe expression language**
- evaluate derived values **at read time** against the active runtime graph
- fully hydrate derived values for browser/public outputs
- carry live derivations through **server projections** when they depend on runtime namespaces such as `process.*`

This keeps CNOS as the single config system while making derived values work the same way across CLI, runtime, build outputs, and projections.

## Key Changes

### 1. Authoring model and expression language
Add a first-class derived-value shape in config files:

```yaml
app:
  origin:
    $derive:
      expr: "concat(value.platform.protocol, '://', value.app.host, when(value.app.port, concat(':', value.app.port), ''))"
```

Authoring rules:
- derived values can live in any **writable data namespace** (`value.*`, declared custom data namespaces)
- derived values cannot be authored under `public.*`, `meta.*`, or `process.*`
- derived expressions may reference:
  - `value.*`
  - declared shareable/non-sensitive custom data namespaces
  - `meta.*`
  - `process.*`
- derived expressions may **not** reference:
  - `secret.*`
  - `public.*`

Use a deliberately small safe DSL:
- literals: string, number, boolean, null
- logical key refs as bare identifiers: `value.app.host`, `process.env.PORT`
- built-ins:
  - `concat(...)`
  - `coalesce(...)`
  - `when(condition, thenValue, elseValue)`
  - `exists(ref)`
  - `eq(a, b)`
  - `ne(a, b)`

Out of scope for v1:
- arbitrary JavaScript
- arithmetic operators
- user-defined functions
- loops, maps, filters
- time/random functions

### 2. Runtime evaluation model
Derived values become part of the resolved graph, but they are evaluated **on demand** by the runtime rather than permanently flattened during graph construction.

Runtime behavior:
- `read`, `require`, `readOr`, `value`, `toEnv`, `toPublicEnv`, `toServerProjection`, and browser/public build helpers all resolve derived values through the same evaluator
- evaluation uses the current runtime graph snapshot plus live runtime namespaces like `process.*`
- evaluation detects dependency cycles and throws a dedicated derivation-cycle error that includes the dependency chain
- missing refs inside a derivation throw a dedicated derivation-resolution error for `read/require/inspect`, while `readOr` still returns the fallback at the top level

Determinism rules:
- no hidden side effects
- no network/filesystem/module access from expressions
- no non-deterministic functions
- repeated reads may legitimately change only when referenced runtime inputs change, for example `process.env.*`

Schema and inspection:
- schema validation should validate the **resolved value**, not the raw `$derive` object
- `inspect()` should expose:
  - that a key is derived
  - the expression
  - dependency keys
  - the resolved value or evaluation error

### 3. CLI surface
Do not add a separate one-off “derive command family”. Extend the existing write flow.

Primary UX:
- `cnos set value app.origin --derive "<expr>"`
- `cnos value set app.origin --derive "<expr>"`
- same pattern for other writable data namespaces:
  - `cnos set flags.banner_text --derive "<expr>"`

CLI behavior:
- `--derive` writes the structured `$derive` object into the target YAML document
- normal `set` behavior stays unchanged for literal values
- `read`, `get`, `list`, and `inspect` resolve derived values transparently
- output should clearly say the key was written as a derived value

Validation at write time:
- reject expressions that reference forbidden namespaces
- reject invalid DSL syntax
- reject writes to readonly/projection/system namespaces

### 4. Projections, build outputs, and browser behavior
Derived values must behave consistently across all CNOS outputs.

Browser/public outputs:
- `toPublicEnv`, `build public`, `build browser`, and framework integrations (`vite`, `next`, `webpack`) always emit **fully resolved concrete values**
- browser payloads never contain raw derivation formulas
- this preserves the current DX: promote once, then read with `@kitsy/cnos/browser`

Server projections:
- extend `ServerProjection` with a `derived` section that carries normalized derivation definitions for keys that remain live at runtime
- `values` continues to hold concrete non-derived values
- `secretRefs` remains refs only
- bootstrapped server runtime evaluates `derived` keys against:
  - projected concrete values
  - projected secret refs where allowed by runtime behavior
  - live `process.*`

Default projection policy:
- browser/public: always freeze to concrete values
- server: preserve derivations in projection so runtime-sensitive keys remain live after build

### 5. Safety, promotion, and docs
Promotion/export safety must apply to derived values transitively.

Rules:
- a derived key may be promoted/exported only if every referenced namespace is allowed for that target
- any derivation that references `secret.*` is invalid in v1
- any derivation that references `process.*` cannot be promoted to browser/public unless its value is fully resolved during build and the referenced runtime source is allowed in that build context

Docs to add/update:
- derived values guide with the `app.origin` example
- CLI docs for `--derive`
- runtime docs explaining read-time evaluation and server projection behavior
- frontend docs showing:
  1. define derived values
  2. promote them
  3. use `@kitsy/cnos/browser`
- server docs showing projection + live `process.*` derivations

## Test Plan
- write and read a simple derived `value.app.origin`
- CLI `set --derive` persists the structured YAML form correctly
- `inspect` shows derived metadata and resolved value
- `concat`, `coalesce`, `when`, `exists`, `eq`, `ne` all behave correctly
- cycles are detected with a readable dependency chain
- invalid syntax is rejected at write time and parse time
- forbidden refs (`secret.*`, `public.*`) are rejected
- `toPublicEnv` and browser integrations emit concrete resolved values only
- server projection preserves derived formulas and resolves them after bootstrap
- `process.*`-based derivations change correctly when runtime process inputs change between reads
- schema validation runs against resolved derived values
- promoted derived values obey the same public/env safety rules as non-derived values

## Assumptions and Defaults
- Authoring uses **structured YAML with `$derive`**, not plain string magic and not manifest-only rules.
- Evaluation is **read-time by default**.
- v1 expression language stays intentionally small and safe.
- Derived values are allowed only in writable data namespaces.
- `secret.*` references are disallowed in derivations for v1.
- Browser/public outputs freeze derived values to concrete values; server projections preserve live derivations where needed.
