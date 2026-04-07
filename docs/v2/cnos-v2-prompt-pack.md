# CNOS v2 — Codex Implementation Prompt

You are evolving CNOS from its shipped v1 to v2. The v1 codebase is working and deployed. v2 is additive — it does not break v1 behavior.

## Authority

The canonical spec is `cnos-v2-spec.md`. The addendum `cnos-v2-addendum.md` explains what changed and why. This prompt tells you what to build and in what order. If this prompt and the spec conflict, the spec wins.

---

## What Changes in v2

v1 has a flat loader list and implicit output. v2 adds:

1. **Named input streams** — loader groups with enablement rules, replacing `plugins.loaders`.
2. **Named output surfaces** — explicit projections (server, browser, env, public) with namespace filtering.
3. **Custom namespaces** — user-defined beyond `value`, `secret`, `meta` (e.g., `flag.*`, `remote.*`).
4. **Browser runtime** — `@kitsy/cnos/browser` reads only promoted + promotable data.
5. **Singleton access** — `import cnos from "@kitsy/cnos"` without explicit `createCnos()`.
6. **Bundler plugin contract** — formalized for Vite, Next, and future Webpack.

What does NOT change: workspace model, profile model, write policy, dump, run, diff, secret vaults, `.cnos-workspace.yml`, local-first authority.

---

## Packages

Existing:
```
packages/cnos/     → @kitsy/cnos (+ new @kitsy/cnos/browser subpath)
packages/cli/      → @kitsy/cnos-cli
packages/vite/     → @kitsy/cnos-vite
packages/next/     → @kitsy/cnos-next
```

No new packages. Browser runtime is a subpath export of `@kitsy/cnos`.

---

## Implementation Order

### Phase 1: Streams + Surfaces

This is the core v2 change. Build it first.

**Build:**

1. **Stream types** — `StreamDefinition`, `StreamEnablementRule`, `ActiveStream`. See spec §7.
2. **Manifest parsing** — parse `streams:` block from `cnos.yml`. If `plugins.loaders` is present instead, convert it to an implicit `default` stream. Both formats must work.
3. **Stream enablement** — evaluate `enabled: always` and `enabled: { when: "env.CI == true" }` at resolution time. The `when` expression evaluates against `process.env`.
4. **Stream-aware loading** — for each active stream, dispatch its loaders with the stream's config. Add `streamId` to `LoaderContext` and `ConfigEntry`.
5. **Precedence** — `resolution.precedence` now references stream IDs. Within a stream, loaders run in declaration order. Across streams, stream precedence order determines winners.
6. **Surface types** — `SurfaceDefinition`, `SurfaceView`. See spec §8.
7. **Surface parsing** — parse `surfaces:` block. If absent, create implicit surfaces matching v1 behavior.
8. **SurfaceView implementation** — filtered read-only view of the resolved graph. Namespace filtering + promotion filtering.
9. **`cnos.surface("browser")`** — returns SurfaceView for the named surface.
10. **Meta keys** — `meta.streams.active` populated with active stream IDs.
11. **`ResolvedGraph.activeStreams`** — list of streams that contributed entries.

**Backward compat:** If manifest has `plugins.loaders` and no `streams`, wrap loaders in one implicit stream. If manifest has no `surfaces`, create implicit server/env/public surfaces. All existing v1 manifests must continue to work.

**Test:**
- Stream parsing from manifest.
- `plugins.loaders` backward compat → implicit default stream.
- Stream enablement: `always` works, conditional works, disabled stream produces no entries.
- `ConfigEntry.streamId` populated correctly.
- Precedence with stream IDs.
- Surface parsing.
- Implicit surfaces when no `surfaces` block.
- `cnos.surface("browser")` returns only promoted `value.*` keys.
- `cnos.surface("browser")` rejects `secret.*`.
- `meta.streams.active` correct.
- All existing v1 tests still pass.

### Phase 2: Custom Namespaces + Browser Runtime

**Build:**

1. **Namespace definition parsing** — parse `namespaces.custom` from manifest. Validate against builtins.
2. **`NamespaceName` type change** — from fixed union to `string`, with validation.
3. **Stream namespace forcing** — if a stream declares `namespace: flag`, all entries from that stream get `flag.*` prefix.
4. **Promotability enforcement** — `public.promote` can reference custom namespace keys only if `promotable: true`. Sensitive namespaces can never be promoted.
5. **Browser runtime module** — `@kitsy/cnos/browser` subpath export. Reads from embedded build-time data. Throws on `secret.*` or non-promoted reads.
6. **Build-time data embedding** — a utility function that resolves the `browser` surface and serializes it to JSON for bundler injection.

**Test:**
- Custom namespace `flag.*` keys resolve correctly.
- `flag.*` keys from Firebase-namespaced stream land in `flag` namespace.
- Promotable custom keys appear in `toPublicEnv()`.
- Sensitive custom namespace blocked from promotion → error.
- Browser runtime reads promoted `value.*` → works.
- Browser runtime reads `flag.*` (promotable + promoted) → works.
- Browser runtime reads `secret.*` → throws.
- Browser runtime reads non-promoted `value.*` → throws.

### Phase 3: Singleton + Bundler Contract

**Build:**

1. **Default stream detection** — find stream with `default: true`.
2. **Singleton module** — `@kitsy/cnos` default export is a lazy singleton. `cnos.ready()` resolves the default stream.
3. **`createCnos()`** — unchanged, still works for explicit config.
4. **`CnosBundlerPlugin` interface** — see spec §10.3.
5. **Refactor `@kitsy/cnos-vite`** — use `CnosBundlerPlugin`. Call `cnos.surface("browser").toEnv()` at build time, apply Vite prefix.
6. **Refactor `@kitsy/cnos-next`** — same, with Next prefix.

**Test:**
- `import cnos from "@kitsy/cnos"` → singleton.
- `cnos.ready()` resolves default stream.
- No default stream → `cnos.ready()` throws clear error.
- `createCnos()` still works (unchanged).
- Vite plugin uses bundler contract → correct `VITE_*` output.
- Next plugin uses bundler contract → correct `NEXT_PUBLIC_*` output.

### Phase 4: Remote Stream Contracts

**Build:**

1. **Remote stream manifest shape** — `config.ref`, `config.version`, `refresh.strategy`, `refresh.ttl`.
2. **Meta keys** — `meta.stream.<id>.version`, `meta.stream.<id>.refreshedAt`.
3. **Remote loader plugin interface** — extends `LoaderPlugin` with `refresh()` method.
4. **Browser-side refresh stub** — browser runtime calls refresh for remote namespace sources if configured.
5. **`cnos doctor`** — warn if remote stream has no version pin.

**Note:** Actual remote loader implementations (GitHub, Firebase) are NOT in scope. This phase defines the contracts and manifest shapes.

**Test:**
- Remote stream meta keys populated.
- Doctor warns on missing version pin.
- Browser refresh stub callable (no-op without actual loader).

### Phase 5: Tests + Docs

**Build:**
- Full v2 test suite (all from spec §22).
- Migration guide: v1 manifest → v2 manifest.
- Updated how-to guide with stream/surface examples.
- Updated README.

---

## Hard Constraints

All v1 constraints, plus:

1. Browser runtime must NEVER access `secret.*` or sensitive namespaces. Test for this.
2. Surfaces are the sole authority for what each consumer sees. No bypass.
3. Streams must be explicitly enabled — no silent activation.
4. Custom namespaces must be declared — undeclared prefixes are errors.
5. Default stream must use local filesystem loaders only.
6. v1 manifests must continue to work without changes (backward compat).
7. `createCnos()` API is unchanged — singleton is additive.

---

## Key Behaviors to Get Right

### Stream enablement evaluation
```yaml
enabled:
  when: env.CI == "true"
```
Evaluate `process.env.CI === "true"`. Support basic equality checks. Do not build a full expression engine.

### Surface filtering
For `filter: public.promote`, iterate `public.promote` list from manifest, intersect with surface's `namespaces`, return only matching entries. `secret.*` and `sensitive: true` namespaces are hard-blocked regardless of promotion.

### Browser data embedding
At build time:
```ts
const cnos = await createCnos({ workspace, profile });
const browserData = cnos.surface("browser").toObject();
// bundler plugin injects browserData as JSON string
```
At browser runtime:
```ts
// @kitsy/cnos/browser reads from injected data
const data = JSON.parse(globalThis.__CNOS_BROWSER_DATA__ || "{}");
```

### Backward compat
```yaml
# v1 format — still works
plugins:
  loaders:
    - filesystem-values
    - filesystem-secrets
    - dotenv
    - process-env
    - cli-args
```
Internally: wrap in `{ streams: { default: { loaders: [...], enabled: "always", default: true } } }`.

### Custom namespace read
```ts
cnos.read("flag.dark-mode.enabled");  // works if flag namespace declared
cnos.read("undeclared.some.key");     // error: undeclared namespace
```

---

## Module Structure

New modules (add to existing layout):

```
packages/cnos/src/
  browser/
    index.ts              # @kitsy/cnos/browser entry
    embed.ts              # build-time data reader
    refresh.ts            # remote refresh stub
  types/
    stream.ts             # StreamDefinition, ActiveStream
    surface.ts            # SurfaceDefinition, SurfaceView type
    namespace.ts          # custom namespace types
  streams/
    resolveStreams.ts      # evaluate enablement
    streamRegistry.ts      # stream ID → loader config mapping
  surfaces/
    resolveSurfaces.ts     # parse surface definitions
    surfaceView.ts         # SurfaceView implementation
    filterGraph.ts         # namespace + promotion filtering
  orchestrator/
    singleton.ts           # default stream singleton
    pipeline.ts            # updated: workspace → streams → load → resolve → validate → surfaces
  validators/
    namespaceSafety.ts     # custom namespace validation
```

---

## Testing Checklist

All v1 tests must still pass. Additional:

- [ ] Stream manifest parsing
- [ ] `plugins.loaders` → implicit default stream (backward compat)
- [ ] Stream enablement: `always`, conditional, disabled
- [ ] `ConfigEntry.streamId` populated
- [ ] Stream precedence ordering
- [ ] Surface manifest parsing
- [ ] Implicit surfaces when no `surfaces` block
- [ ] `cnos.surface("browser")` → only promoted + promotable
- [ ] `cnos.surface("browser")` rejects `secret.*`
- [ ] Custom namespace `flag.*` resolves
- [ ] Promotable custom namespace in public export
- [ ] Sensitive namespace blocked from promotion
- [ ] Browser runtime reads promoted → works
- [ ] Browser runtime reads `secret.*` → throws
- [ ] Browser runtime reads non-promoted `value.*` → throws
- [ ] Singleton `cnos.ready()` resolves default stream
- [ ] No default stream → `cnos.ready()` throws
- [ ] `createCnos()` unchanged
- [ ] Vite plugin uses bundler contract
- [ ] Next plugin uses bundler contract
- [ ] Remote stream meta keys populated
- [ ] Doctor warns on missing version pin
- [ ] Undeclared namespace → error
- [ ] `meta.streams.active` populated
- [ ] v1 manifest works without changes

---

## Style

Same as v1:
- Production-oriented, readable code.
- Small, focused modules.
- Explicit interfaces. Explicit error messages.
- TypeScript strict mode.
- No premature abstraction.
- v2 additions are additive — do not refactor working v1 code unnecessarily.
