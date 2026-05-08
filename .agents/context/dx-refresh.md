# DX Refresh Reference

Full spec: see `cnos-dx-refresh.md` in project docs.

## Core Idea

Regular mode (flat `.cnos/`) and workspace mode (`.cnos/workspaces/`) are a natural progression, not separate systems.

```
Solo project (regular)  →  workspace enable  →  Monorepo (workspaces)
.cnos/{values,secrets}     .cnos/workspaces/base/  .cnos/workspaces/{base,api,web}/
```

## Key Rules

- `base` is the conventional shared workspace name. Not hardcoded — just default scaffold name and auto-extends target.
- `local` is the default profile. Never `base` (that's a workspace).
- Flat repos are treated as "implicit `base`" in docs and CLI output.

## Commands

`cnos workspace enable`: converts flat `.cnos/` to workspace mode with explicit `base`. Moves dirs, updates manifest.

`cnos init --mode workspace`: scaffolds with `base` workspace from the start.

`cnos workspace add api`: auto-sets `extends: [base]` when `base` exists. `--extends none` to skip.

## Onboard

`cnos onboard`: imports existing config sources (.env, YAML, JSON, TOML) into CNOS.

- Interactive by default: prints proposed mappings, asks confirmation.
- `--materialize`: auto-accept without prompt.
- `--source-only`: copy file only, skip value materialization.
- Non-interactive shell without flags: source-only fallback with printed hint.
- Default mapping: `FOO_BAR_BAZ` → `value.foo.bar.baz`.
- `--prefix db`: scope all imports under `value.db.*`.
- Secret-like keys (`*_PASSWORD`, `*_SECRET`, `*_KEY`, `*_TOKEN`) flagged with warning, not auto-classified.
