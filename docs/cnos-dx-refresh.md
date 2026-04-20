# CNOS DX Refresh: Implicit Base Workspace, Smarter Onboard, and Clearer Workspace Lifecycle

**Status:** Implementation-ready.
**Scope:** `cnos` repo. DX improvement, no architectural changes.

---

## 1. What This Improves

Regular mode (flat `.cnos/`) and workspace mode (`.cnos/workspaces/`) currently feel like two separate systems. This change makes them feel like a natural progression:

```
Solo project          →  Growing project        →  Monorepo
(regular mode)           (workspace enable)         (multiple workspaces)
.cnos/                   .cnos/workspaces/base/     .cnos/workspaces/base/
  values/                  values/                    values/
  secrets/                 secrets/                   secrets/
  profiles/                profiles/                  profiles/
                                                    .cnos/workspaces/api/
                                                    .cnos/workspaces/web/
```

No rewrite at any step. The flat repo becomes the `base` workspace. Child workspaces inherit from `base` by default.

---

## 2. Key Changes

### 2.1 Implicit `base` workspace

A flat regular-mode repo is treated as an **implicit `base` workspace** by the runtime, CLI, and onboarding flows. This is not a code change in the resolver — the resolver already handles single-workspace mode. This is a naming convention and DX decision:

- When docs, CLI output, and help text refer to the config tree in a regular-mode repo, they call it `base`.
- When `cnos workspace enable` converts a regular repo to workspace mode, the flat tree becomes the explicit `base` workspace.
- When `cnos init` creates a workspace-mode repo, the shared root workspace is called `base`.

**`base` is conventional, not magically special.** It is the default scaffold name and the default `extends` target. But a team that prefers `shared` or `common` can use that — they just pass `--extends shared` explicitly on `workspace add`. The resolver does not hardcode `base` anywhere.

### 2.2 Profile default: `local`, not `base`

New scaffolds default to `profiles.default: local`. This avoids confusion between workspace names and profile names:

- `base` = workspace (config tree composition)
- `local` = profile (environment activation)

These are orthogonal concepts and should never share a name.

### 2.3 `cnos workspace enable`

New primary command for converting a regular-mode repo to workspace mode.

```bash
cnos workspace enable
```

What it does:

1. Verify the repo is in regular mode (flat `.cnos/` with no `workspaces` block).
2. Create `.cnos/workspaces/base/`.
3. Move `.cnos/values/` → `.cnos/workspaces/base/values/`.
4. Move `.cnos/secrets/` → `.cnos/workspaces/base/secrets/`.
5. Move `.cnos/env/` → `.cnos/workspaces/base/env/`.
6. Move `.cnos/profiles/` → `.cnos/workspaces/base/profiles/`.
7. Update `.cnos/cnos.yml`:
   - Add `workspaces: { default: base, items: { base: {} } }`.
   - Update `sources` paths to workspace-relative form.
   - Update `writePolicy` paths.
8. Update `.cnosrc.yml` (if exists) to add `workspace: base`.
9. Print summary of what moved.

**Safety:**
- Refuses if repo is already in workspace mode.
- Refuses if `.cnos/workspaces/base/` already exists.
- Creates no backup — this is a git-tracked operation, the user can `git diff` and revert.

### 2.4 Updated `cnos init` semantics

```bash
# Regular mode (default) — flat .cnos/, profiles.default: local
cnos init

# Workspace mode — creates base workspace
cnos init --mode workspace

# Workspace mode with named workspaces
cnos init --mode workspace --workspaces api,web,agents
# Creates base + api + web + agents, each extending base
```

The `--mode workspace` flag is unambiguous. No bare `--workspace` flag with optional value.

### 2.5 Default workspace inheritance

When adding a workspace to a repo that has a `base` workspace:

```bash
cnos workspace add api
# Automatically sets extends: [base] because base exists
# Equivalent to: cnos workspace add api --extends base
```

If `base` does not exist, no automatic `extends` is set. The `--extends` flag always overrides the default.

```bash
cnos workspace add api --extends shared
# Uses shared instead of base

cnos workspace add api --extends none
# No inheritance
```

---

## 3. Onboard Improvements

### 3.1 Source format support

Expand `cnos onboard` to accept multiple config source formats:

```bash
cnos onboard                           # auto-discover .env* in project root (existing)
cnos onboard --env .env.production     # specific env file
cnos onboard --yaml config/app.yml     # YAML config file
cnos onboard --json config/settings.json  # JSON config file
cnos onboard --toml config/app.toml    # TOML config file
cnos onboard --config config/app.yml   # auto-detect format from extension
```

### 3.2 Value materialization

Current behavior: `cnos onboard` copies the source file into `.cnos/env/`.

New behavior: `cnos onboard` copies the source file AND prints proposed `value.*` entries, asking for confirmation before materializing them.

```bash
cnos onboard --env .env.production
# Copied .env.production → .cnos/env/.env.production
#
# Discovered 8 entries. Proposed value mappings:
#
#   DATABASE_HOST     → value.database.host = "prod-db.example.com"
#   DATABASE_PORT     → value.database.port = "5432"
#   API_KEY           → value.api.key = "sk_live_..."  ⚠ looks like a secret
#   NEXT_PUBLIC_URL   → value.app.url = "https://example.com"  (public candidate)
#
# Materialize these values? [Y/n/edit]
```

Materialization is **interactive by default**. Flags for non-interactive use:

```bash
cnos onboard --env .env --materialize       # auto-materialize without prompt
cnos onboard --env .env --source-only       # copy file only, no value materialization
```

### 3.3 Default key mapping

| Source format | Input | Output |
|---------------|-------|--------|
| Env | `FOO_BAR_BAZ=hello` | `value.foo.bar.baz = "hello"` |
| Env | `DATABASE_HOST=x` | `value.database.host = "x"` |
| YAML | `{ db: { host: "x" } }` | `value.db.host = "x"` |
| JSON | `{ "api": { "url": "x" } }` | `value.api.url = "x"` |
| TOML | `[server]\nport = 3000` | `value.server.port = 3000` |

All values land under `value.*` by default. No automatic `secret.*` or `public.*` inference — the tool flags suspicious keys (like `*_KEY`, `*_SECRET`, `*_PASSWORD`) with a warning but does not auto-classify.

### 3.4 `--prefix` for scoped import

```bash
cnos onboard --yaml config/db.yml --prefix db
# { host: "localhost", port: 5432 } → value.db.host, value.db.port
```

### 3.5 Workspace-aware onboard

```bash
# Regular mode: imports into implicit base
cnos onboard --env .env

# Workspace mode: imports into selected workspace
cnos onboard --env .env --workspace api
```

---

## 4. CLI Help Consistency

### 4.1 Fix help routing

These help topics must work and reflect the actual executable surface:

```bash
cnos help workspace           # workspace overview
cnos help workspace add       # add a workspace
cnos help workspace enable    # convert regular → workspace mode
cnos help workspace detach    # detach to standalone
cnos help workspace attach    # reattach to parent
cnos help onboard             # onboard overview
cnos help init                # init overview
```

### 4.2 Remove aliases

Do not keep `cnos workspace add base --onboard-current` as an alias for `workspace enable`. One command, one way. If the old alias exists in code, remove it.

---

## 5. Docs Updates

### 5.1 Files to update in `@kitsy/cnos-docs`

| File | Change |
|------|--------|
| `getting-started/quick-start.mdx` | Show `cnos init` with `profiles.default: local` |
| `getting-started/your-first-project.mdx` | End with hint about `workspace enable` when ready to grow |
| `guides/workspaces.mdx` | Explain regular → workspace progression, `base` convention, `workspace enable` |
| `cli/init.mdx` | Document `--mode workspace`, `--workspaces` |
| `cli/onboard.mdx` | **New file.** Full onboard reference with all flags |
| `cli/workspace.mdx` | Update with `enable`, remove alias mentions |

### 5.2 Consistent examples

All examples in docs should show:
- `profiles.default: local` (never `base` as a profile)
- `base` as workspace root (when workspace mode is shown)
- Child workspaces `extends: [base]`
- Progression: regular → `workspace enable` → add children

---

## 6. Test Plan

### Init

- [ ] DX-I-1: `cnos init` creates regular mode, `profiles.default: local`, no workspaces block.
- [ ] DX-I-2: `cnos init --mode workspace` creates workspace mode with `base` workspace.
- [ ] DX-I-3: `cnos init --mode workspace --workspaces api,web` creates `base` + `api` + `web`, each extending `base`.
- [ ] DX-I-4: Scaffolded manifest has `profiles.default: local`, never `base`.

### Workspace enable

- [ ] DX-WE-1: `workspace enable` moves flat dirs into `workspaces/base/`.
- [ ] DX-WE-2: Manifest updated with workspaces block.
- [ ] DX-WE-3: `.cnosrc.yml` updated with `workspace: base`.
- [ ] DX-WE-4: Already in workspace mode → error.
- [ ] DX-WE-5: `workspaces/base/` already exists → error.
- [ ] DX-WE-6: After enable, `cnos read value.x` still returns correct value.
- [ ] DX-WE-7: After enable, `cnos workspace add api` defaults `extends: [base]`.

### Workspace add defaults

- [ ] DX-WA-1: `workspace add api` with `base` existing → auto `extends: [base]`.
- [ ] DX-WA-2: `workspace add api --extends shared` → uses `shared`.
- [ ] DX-WA-3: `workspace add api --extends none` → no extends.
- [ ] DX-WA-4: `workspace add api` without `base` existing → no extends.

### Onboard

- [ ] DX-OB-1: `cnos onboard` auto-discovers `.env*` files.
- [ ] DX-OB-2: `cnos onboard --env .env.prod` imports specific file.
- [ ] DX-OB-3: `cnos onboard --yaml config.yml` imports YAML.
- [ ] DX-OB-4: `cnos onboard --json settings.json` imports JSON.
- [ ] DX-OB-5: `cnos onboard --toml app.toml` imports TOML.
- [ ] DX-OB-6: `cnos onboard --config app.yml` auto-detects format.
- [ ] DX-OB-7: Default onboard prints proposed mappings, waits for confirmation.
- [ ] DX-OB-8: `--materialize` auto-accepts without prompt.
- [ ] DX-OB-9: `--source-only` skips value materialization.
- [ ] DX-OB-10: Env `FOO_BAR_BAZ` → `value.foo.bar.baz`.
- [ ] DX-OB-11: YAML nested `{ db: { host: "x" } }` → `value.db.host`.
- [ ] DX-OB-12: `--prefix db` scopes all values under `value.db.*`.
- [ ] DX-OB-13: Secret-like keys flagged with warning, not auto-classified.
- [ ] DX-OB-14: `--workspace api` imports into workspace `api`.
- [ ] DX-OB-15: Regular mode onboard imports into implicit base.

### Help

- [ ] DX-H-1: `cnos help workspace` works.
- [ ] DX-H-2: `cnos help workspace enable` works.
- [ ] DX-H-3: `cnos help onboard` works.
- [ ] DX-H-4: No alias for `workspace add base --onboard-current`.

### Round-trip

- [ ] DX-RT-1: `cnos onboard --env .env --materialize` → `cnos build env --to .env.out` → output matches original values.
- [ ] DX-RT-2: `workspace enable` → all values still readable → `cnos build env` unchanged.

---

## 7. Assumptions

- `base` is conventional, not hardcoded in the resolver.
- Existing flat repos continue to work without changes.
- Conversion happens only via explicit `workspace enable`.
- Onboard value materialization is interactive by default.
- No `--transform <script>` in this release — `--prefix` covers scoped import needs.
- Profile default is always `local`. Workspace default is `base`. These never collide.