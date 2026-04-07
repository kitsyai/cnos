# CNOS v2 — Codex Implementation Prompt

You are evolving CNOS from its shipped v1 to v2. The v1 codebase is working and stable. v1 has already received the v1 change set additions (codegen, watch, migrate, drift, singleton, browser runtime, internal stream tagging). v2 builds on all of that.

## Authority

The canonical spec is `cnos-v2-spec.md`. The addendum `cnos-v2-addendum.md` explains what changed and why. This prompt tells you what to build and in what order. Spec wins on conflict.

---

## What v2 Changes

v2 makes three architectural shifts on top of the working v1+changeset codebase:

1. **Manifest simplification** — 7 sections instead of 12. New `config.ts` alternative. `version: 2` in manifest.
2. **User-facing streams** — named input source groups with enablement, replacing flat loader lists.
3. **User-facing surfaces** — named output projections with namespace filtering, making server/browser boundaries explicit.

What does NOT change: workspace model, profile model, resolution logic, write policy, dump, run, diff, secret vaults, local-first authority.

---

## Packages

Same as v1:
```
packages/cnos/     → @kitsy/cnos (+ /browser, /build subpaths)
packages/cli/      → @kitsy/cnos-cli
packages/vite/     → @kitsy/cnos-vite
packages/next/     → @kitsy/cnos-next
```

---

## Implementation Order

### Phase 1: Manifest v2 + `config.ts`

**Build:**

1. **Manifest v2 parser.** Parse the new v2 shape with 7 top-level sections: `project`, `workspaces`, `profiles`, `config`, `env`, `public`, `schema`. Plus optional `namespaces` and `surfaces`. See spec §7.
2. **`config.ts` loader.** Load `.cnos/config.ts` via dynamic import when it exists. It exports a `defineConfig()` call that returns the same normalized shape. Check for `config.ts` first, then `cnos.yml`.
3. **`defineConfig()` helper.** Exported from `@kitsy/cnos`. Takes a typed config object, returns it. Purely for autocompletion in the config file.
4. **v1 compat layer.** When `version: 1` is detected in `cnos.yml`, normalize to v2 internal shape: `plugins.loaders` → `config.streams` (implicit), `envMapping` → `env`, `writePolicy` → `config.write`, `sources` + `resolution` → `config`. All existing v1 manifests must continue to work.
5. **Validation.** `version: 2` manifests are validated against v2 schema. `version: 1` manifests are normalized then validated.

**Test:**
- v2 YAML manifest parses correctly.
- `config.ts` loads and produces correct normalized manifest.
- v1 manifest normalizes to v2 internal shape.
- Missing optional sections use sensible defaults.
- Invalid v2 manifest → clear error.
- `defineConfig()` returns input unchanged.

### Phase 2: User-Facing Streams

**Build:**

1. **Stream parsing.** Parse `config.streams` into `StreamDefinition[]`. Each stream has ID, loaders, config, enabled rule, optional namespace, optional refresh. See spec §8.
2. **Stream enablement.** `enabled: "always"` → always active. `enabled: { when: "CI" }` → active when `process.env.CI` is truthy. Simple env var check, no expression engine.
3. **Stream dispatch.** For each active stream, dispatch its loaders with stream-specific config in `LoaderContext.streamConfig`. Add `streamId` to all produced `ConfigEntry` instances.
4. **Precedence.** `config.precedence` references stream IDs. Within a stream, loaders run in declaration order. Across streams, the precedence list determines order.
5. **Implicit streams.** If no `config.streams`, auto-generate: `files` = filesystem + dotenv (enabled always, default true), `env` = process-env + cli-args (enabled always).
6. **`ResolvedGraph.activeStreams`** — list of streams that contributed entries.
7. **`meta.streams.active`** — meta key with active stream IDs.

**Note:** v1 internal stream tagging (from v1 changeset Phase 5b) already added `streamId` to `ConfigEntry`. This phase makes streams user-configurable.

**Test:**
- Stream parsing from manifest.
- Implicit streams when no `config.streams`.
- `enabled: always` works.
- `enabled: { when: CI }` works (with and without CI set).
- Disabled stream produces no entries.
- Stream precedence ordering.
- `meta.streams.active` populated.
- All v1 tests still pass.

### Phase 3: User-Facing Surfaces + Custom Namespaces

**Build:**

1. **Surface parsing.** Parse `surfaces` block into `SurfaceDefinition[]`. See spec §9.
2. **`SurfaceView` implementation.** Filtered read-only view. Filters by `namespaces` list and `filter` rule (`public.promote` or `env.export`). Throws on reads outside the surface's allowed namespaces.
3. **`cnos.surface("browser")`** — returns SurfaceView for the named surface.
4. **Implicit surfaces.** If no `surfaces` block: server (all), browser (value, filter public.promote), env (value+secret, filter env.export), public (value, filter public.promote, with framework prefixes).
5. **Custom namespace parsing.** Parse `namespaces` block. Validate against builtins (value, secret, meta). See spec §10.
6. **`NamespaceName` validation.** Change from fixed union to string with validation. Undeclared namespace prefix in a key → error at resolution time.
7. **Sensitive enforcement.** Custom namespace with `sensitive: true` → never promotable, never on browser surface.
8. **Promotable enforcement.** Custom namespace in `public.promote` allowed only if `promotable: true`.

**Test:**
- Server surface sees all namespaces.
- Browser surface sees only promoted + promotable.
- `secret.*` never on browser surface.
- Sensitive custom namespace blocked from browser.
- `cnos.surface("browser").read("secret.x")` → throws.
- Custom namespace `flag.*` resolves.
- Promotable custom key in public export → works.
- Non-promotable key in public promote → error.
- Implicit surfaces when no `surfaces` block.
- Undeclared namespace → error.

### Phase 4: Bundler Contract + Remote Contracts

**Build:**

1. **`CnosBundlerPlugin` interface.** See spec §11.3.
2. **Refactor `@kitsy/cnos-vite`.** Implement `CnosBundlerPlugin`. Resolve browser surface at build time. Apply `VITE_*` prefix.
3. **Refactor `@kitsy/cnos-next`.** Same, with `NEXT_PUBLIC_*`.
4. **Remote loader interface.** `RemoteLoaderPlugin extends LoaderPlugin` with `refresh(): Promise<ConfigEntry[]>`.
5. **Remote meta keys.** `meta.stream.<id>.version`, `meta.stream.<id>.refreshedAt`.
6. **`cnos doctor`** — warn if remote stream has no version/ref pin.
7. **Browser-side refresh stub.** `@kitsy/cnos/browser` has a `refresh()` function that no-ops without a real remote loader but is wired for when one ships.

**Note:** Actual remote loader implementations (GitHub, Firebase) are NOT in scope. This phase defines contracts.

**Test:**
- Vite plugin uses bundler contract.
- Next plugin uses bundler contract.
- Remote meta keys populated when remote stream is configured.
- Doctor warns on missing version pin.
- Browser refresh stub callable.

### Phase 5: Polish

- Full v2 test suite.
- v1 → v2 manifest migration guide.
- Updated how-to guide.
- Updated README.

---

## Hard Constraints

All v1 constraints, plus:

1. Browser runtime must NEVER access `secret.*` or sensitive namespaces.
2. Surfaces are the sole authority for consumer visibility.
3. Streams must be explicitly enabled.
4. Custom namespaces must be declared.
5. Default stream must use local filesystem loaders only.
6. v1 manifests (version 1) must work through the compat layer.
7. `createCnos()` API is unchanged.
8. `config.ts` and `cnos.yml` are mutually exclusive per project.

---

## Key Behaviors

### Manifest loading order
1. Check for `.cnos/config.ts` → dynamic import → `defineConfig()` result.
2. If not found, check for `.cnos/cnos.yml` → YAML parse.
3. If `version: 1`, normalize to v2 internal shape.
4. Fill defaults for missing optional sections.

### Stream enablement
```yaml
enabled: { when: CI }
```
Means: `if (process.env["CI"]) { active }`. Truthy check only. No expression parser.

### Surface filtering
For `filter: public.promote`: intersect `public.promote` keys with surface's `namespaces`. Block `secret.*` and `sensitive` namespaces unconditionally.

### Implicit defaults
No `config.streams` → implicit `files` + `env` streams.
No `surfaces` → implicit server/browser/env/public surfaces.
No `profiles` → default profile is `local`.
No `config.precedence` → default `[files, dotenv, env, cli]`.

### Backward compat
v1 manifest:
```yaml
version: 1
plugins:
  loaders: [filesystem-values, filesystem-secrets, dotenv, process-env, cli-args]
```
Normalizes to v2:
```
config.streams.default = { loaders: [filesystem-values, filesystem-secrets, dotenv], enabled: "always", default: true }
config.streams.env = { loaders: [process-env, cli-args], enabled: "always" }
```

---

## Module Structure

New modules (add to existing v1+changeset layout):

```
packages/cnos/src/
  manifest/
    loadConfigTs.ts          # NEW: .cnos/config.ts loader
  types/
    stream.ts                # NEW
    surface.ts               # NEW
    namespace.ts             # NEW
  streams/
    resolveStreams.ts         # NEW
    streamRegistry.ts         # NEW
  surfaces/
    resolveSurfaces.ts        # NEW
    surfaceView.ts            # NEW
    filterGraph.ts            # NEW
  validators/
    namespaceSafety.ts        # NEW
  orchestrator/
    pipeline.ts               # UPDATED: workspace → streams → load → resolve → validate → surfaces
```

---

## Testing Checklist

All v1+changeset tests must pass. Additional:

- [ ] v2 YAML manifest parses
- [ ] `config.ts` loads
- [ ] v1 manifest normalizes to v2
- [ ] Stream parsing
- [ ] Implicit streams
- [ ] Stream enablement (always, conditional, disabled)
- [ ] Stream precedence
- [ ] `meta.streams.active`
- [ ] Surface parsing
- [ ] Implicit surfaces
- [ ] `cnos.surface("browser")` → promoted only
- [ ] `cnos.surface("browser")` rejects `secret.*`
- [ ] Custom namespace resolves
- [ ] Promotable custom in public → works
- [ ] Sensitive custom in public → error
- [ ] Undeclared namespace → error
- [ ] Vite plugin uses bundler contract
- [ ] Next plugin uses bundler contract
- [ ] Remote meta keys
- [ ] Doctor warns on missing version pin
- [ ] v1 manifests still work

---

## Style

Same as v1: production code, small modules, explicit interfaces, TypeScript strict, no premature abstraction. v2 additions are additive — do not refactor working v1 code unnecessarily.
