# Derived Values Reference

Full spec: see `cnos-derived-values.md` in project docs.

## Authoring

Two syntaxes:
```yaml
# Template shorthand (80% of cases)
app:
  origin:
    $derive: "${value.app.protocol}://${value.app.host}:${value.app.port}"

# Expression syntax (conditionals)
app:
  port:
    $derive:
      expr: "coalesce(process.env.PORT, value.app.default_port, '3000')"
```

Detection: YAML value is an object with `$derive` key. String = template, object with `expr` = expression.

## Expression Language

Six built-in functions only:
- `concat(a, b, ...)` → string
- `coalesce(a, b, ...)` → first non-null
- `when(cond, then, else)` → conditional
- `exists(ref)` → boolean
- `eq(a, b)` → boolean
- `ne(a, b)` → boolean

No arithmetic, no JS, no imports, no side effects, no I/O.

## Namespace Rules

- Can author in: `value.*`, custom writable data namespaces.
- Cannot author in: `secret.*`, `public.*`, `meta.*`, runtime namespaces.
- Can reference: `value.*`, `meta.*`, custom shareable namespaces, runtime namespaces.
- Cannot reference: `secret.*`, `public.*`.

## Caching — THE Critical Rule

**Config-only derivations** (all deps are config namespaces): cached once per resolution pass. Same result every read.

**Runtime-dependent derivations** (any dep is a runtime namespace like `process.*`, `request.*`): NEVER cached. Evaluated fresh on every read.

Detection is transitive: if A → B → process.env.X, then A is runtime-dependent.

## Runtime Namespaces

`process.*` is a built-in runtime namespace. Users can declare custom runtime namespaces in manifest and register providers via `cnos.registerRuntimeProvider("request", fn)`.

Runtime providers must be synchronous, idempotent, and side-effect-free.

## Projection Behavior

- Browser/public: always concrete values. Runtime-dependent promoted key → build error.
- Server: config-only derivations → concrete in `values`. Runtime-dependent → formulas in `derived`.
- Env: all resolved to concrete. Unresolvable runtime refs → skip with warning.
