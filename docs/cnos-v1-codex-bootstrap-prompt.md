# CNOS v1 — Codex Bootstrap Prompt

You are implementing CNOS from a fresh start. This is a new implementation with no legacy compatibility.

## What CNOS Is

CNOS is a configuration resolution system. Sources → Loader plugins → CNOS core (namespace, resolve, validate) → Projections / Exports / Read APIs.

Application code reads logical keys like `value.inventory.db.host`. CNOS decides where values come from and how they're resolved. Plugins extend both sides.

## Authority

The canonical spec is `cnos-v1-canonical-spec.md`. This prompt tells you what to build and in what order. The spec tells you how everything works. If this prompt and the spec conflict, the spec wins.

---

## Packages

Create these in a pnpm monorepo workspace:

```
packages/
  cnos-core/    → orchestrator, plugin contracts, resolution engine
  cnos/         → batteries-included entry with default v1 plugins
  cnos-cli/     → CLI commands
```

Published as `@kitsy/cnos-core`, `@kitsy/cnos`, `@kitsy/cnos-cli`.

---

## Implementation Order

Build in this exact sequence. Each phase should pass its tests before moving to the next.

### Phase 1: Core Types + Filesystem Loaders

**Build:**
1. All types from spec §7 (LogicalKey, NamespaceName, ConfigEntry, ResolvedEntry, ResolvedGraph, all plugin interfaces). Note: loaders are called "loaders" not "readers". NamespaceName is `"value" | "secret" | "meta"` — there is no `"public"` namespace.
2. Manifest loader: read `cnos/cnos.yml`, parse, normalize. See spec §8 for full schema.
3. `filesystem-values` loader: reads YAML from `values/` root, flattens to `value.*` keys. See spec §11.1.
4. `filesystem-secrets` loader: reads YAML from `secrets/` root, flattens to `secret.*` keys. See spec §11.2.
5. Profile-aware resolver in flat mode (no inheritance yet — just precedence merge). See spec §12.
6. Runtime: `read`, `require`, `readOr`. See spec §17.2.
7. Meta namespace population: `meta.profile`, `meta.cnos.version`, `meta.resolved.at`, `meta.resolved.from`. See spec §5.3.
8. `createCnos(...)` entry in `@kitsy/cnos`. See spec §17.1.

**Test:** Manifest loads. Filesystem values/secrets produce correct namespaced keys. Flat precedence merge works. `read`/`require`/`readOr` work. Meta keys populated.

### Phase 2: Remaining Loaders + Env Mapping

**Build:**
1. `dotenv` loader: reads `.env` files per profile activation. See spec §11.3.
2. `process-env` loader: reads `process.env`. See spec §11.4.
3. `cli-args` loader: parses `--value.x.y=z` style args. See spec §11.5.
4. Convention-based env mapping (`SCREAMING_SNAKE`) and explicit overrides. See spec §16.
5. Full precedence pipeline across all loaders. See spec §12.1.
6. Inspect/provenance: `inspect()` method and provenance inspector plugin. See spec §14.

**Test:** All loaders produce correct entries. Env mapping works bidirectionally. Precedence: filesystem < dotenv < process-env < cli-args. Inspect returns correct winner and override chain.

### Phase 3: Profiles + Export

**Build:**
1. Profile chain expansion from profile YAML files. See spec §10.
2. Inheritance cycle detection (hard error on cycles).
3. Profile chain integration into resolver (parents first, then child).
4. `toEnv()` exporter. See spec §15.1.
5. `toPublicEnv()` exporter with promotion logic. See spec §15.2.
6. Framework prefix projection (`NEXT_PUBLIC_`, `VITE_`, `NUXT_PUBLIC_`). See spec §15.3.
7. `toObject()`, `toNamespace()`.
8. Convenience helpers: `value()`, `secret()`, `meta()`.

**Test:** Profile inheritance works. Cycle detection catches cycles. Public promotion only includes declared `value.*` keys. `secret.*` in promotion → error. Framework projection correct.

### Phase 4: CLI

**Build all commands from spec §18:**
1. `cnos init` — scaffold structure, generate `.gitignore` with `cnos/secrets/` entry.
2. `cnos read <logical-key>` with `--profile` and `--json` flags.
3. `cnos value <path>` and `cnos secret <path>` as aliases.
4. `cnos define <namespace> <path> <value>` with write policy routing. See spec §19.
5. `cnos inspect <logical-key>` with human-readable and `--json` output.
6. `cnos validate` — run schema validator + public safety checks.
7. `cnos export env` with `--public`, `--framework`, `--profile`, `--json` flags.
8. `cnos run -- <command>` — resolve, export to env, spawn child. See spec §18.8.
9. `cnos diff --from <profile> --to <profile>` with `--json`. See spec §18.9.
10. `cnos doctor` — all health checks from spec §18.10.

**Test:** Each command produces expected output. `define` then `read` round-trips. `run` spawns with correct env. `diff` shows correct delta. `doctor` catches misconfigs.

### Phase 5: Validation + Polish

**Build:**
1. Basic schema validator: type, required, enum, pattern, default. See spec §13.
2. Public safety validator: secret in promote → error. See spec §13.3.
3. Full test suite: unit, integration, golden. See spec §21.
4. README with quickstart, CLI reference, and example project.
5. Starter example config tree (used by `cnos init`).

---

## Hard Constraints

These are non-negotiable. Violating any of them is a bug.

1. `secret.*` keys must NEVER appear in public export output. Test for this.
2. CLI `define` must be deterministic — same input, same target file, every time.
3. Plugin boundaries must not be collapsed. Each loader/resolver/validator/exporter/inspector is a separate module.
4. There is no `public.*` namespace. Public is promotion of `value.*` keys via manifest config.
5. The resolver is one plugin (`profile-aware`) that handles both flat and inherited cases.
6. Env mapping supports both convention-based and explicit. Convention is not optional — implement `SCREAMING_SNAKE`.
7. `cnos run -- <cmd>` must work with zero application code changes.
8. All loaders produce `ConfigEntry[]`. All entries include `origin` for provenance.
9. Prefer correctness and readability over cleverness.

---

## Module Structure

Follow spec §20 exactly. Key files:

```
packages/cnos-core/src/
  index.ts
  types/         → core.ts, plugin.ts, manifest.ts, profile.ts, schema.ts, export.ts
  manifest/      → loadManifest.ts, normalizeManifest.ts
  profiles/      → resolveActiveProfile.ts, expandProfileChain.ts
  orchestrator/  → createCnos.ts, runtime.ts, pipeline.ts
  loaders/       → filesystemValues.ts, filesystemSecrets.ts, dotenv.ts, processEnv.ts, cliArgs.ts
  resolvers/     → profileAwareResolver.ts
  validators/    → basicSchema.ts, publicSafety.ts
  exporters/     → toEnv.ts, toPublicEnv.ts
  inspectors/    → provenance.ts
  utils/         → path.ts, flatten.ts, deepMerge.ts, yaml.ts, envNaming.ts
```

---

## Key Behaviors to Get Right

### Namespace Assignment
- Files under `values/` → `value.*` keys. Always.
- Files under `secrets/` → `secret.*` keys. Always.
- No magic file-name-based namespace switching.

### Env Mapping Convention
`value.server.port` → `SERVER_PORT` (strip `value.` prefix, SCREAMING_SNAKE).
`secret.inventory.db.password` → `SECRET_INVENTORY_DB_PASSWORD` (keep `secret.` prefix to avoid collision).

### Public Promotion
Read `public.promote` from manifest. Filter resolved graph to only those keys. Verify all are `value.*`. Apply framework prefix. Return.

### Profile Resolution
1. `--profile` flag
2. `CNOS_PROFILE` env var
3. `profiles.default` from manifest

### Write Policy
`cnos define value "server.port" "3000"` →
1. Profile = `--profile` or `writePolicy.define.defaultProfile`
2. Pattern = `writePolicy.define.targets.value` → `./values/{profile}/app.yml`
3. Substitute → `./values/local/app.yml`
4. Deep-write YAML: `{ server: { port: "3000" } }`
5. Safety: refuse if namespace/directory mismatch

### `cnos run`
1. Resolve full config graph
2. Call `toEnv()` to get flat env map
3. Spawn child process with `{ ...process.env, ...envMap }`
4. Pipe stdout/stderr through
5. Exit with child's exit code

---

## Testing Checklist

At minimum, these test cases must exist and pass:

- [ ] Manifest loads from `cnos/cnos.yml`
- [ ] Invalid manifest → clear error
- [ ] Filesystem values produces `value.*` keys from nested YAML
- [ ] Filesystem secrets produces `secret.*` keys
- [ ] Dotenv maps env vars to logical keys via explicit mapping
- [ ] Dotenv maps env vars via convention when no explicit mapping exists
- [ ] Process env loader respects same mapping
- [ ] CLI args override with highest precedence
- [ ] Deep merge: nested objects merge, scalars override, arrays replace
- [ ] Profile resolution: CLI > env > default
- [ ] Profile inheritance: parent layers applied before child
- [ ] Inheritance cycle → error
- [ ] `read()` returns undefined for missing key
- [ ] `require()` throws for missing key
- [ ] `readOr()` returns fallback for missing key
- [ ] `inspect()` shows winner and override chain
- [ ] `toPublicEnv()` includes only promoted `value.*` keys
- [ ] `toPublicEnv()` with framework prefix produces correct output
- [ ] `secret.*` in `public.promote` → validation error
- [ ] `define value` writes to correct file per write policy
- [ ] `define secret` writes to correct file per write policy
- [ ] `define value` then `read value` round-trip
- [ ] `cnos run -- <cmd>` injects resolved env
- [ ] `cnos diff` shows correct differences between profiles
- [ ] `cnos doctor` warns if secrets not gitignored
- [ ] Meta keys (`meta.profile`, `meta.cnos.version`, `meta.resolved.at`) populated
- [ ] Convention env mapping: `value.server.port` → `SERVER_PORT`
- [ ] Explicit env mapping overrides convention

---

## Style

- Production-oriented, readable code.
- Small, focused modules — one concern per file.
- Explicit interfaces. Explicit error messages.
- Comments for non-obvious behavior only.
- No over-engineering. No premature abstraction.
- TypeScript strict mode.
