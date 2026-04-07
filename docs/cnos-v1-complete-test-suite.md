# CNOS v1 — Complete System Test Suite

**Scope:** This covers the entire CNOS v1 system: the shipped base, the pre-changeset additions (namespaces, promotion, singleton, browser, vault, .env bridge), and the changeset additions (codegen, watch, migrate, drift). Every test listed must pass before v1 enters maintenance.

**Rule:** A code agent must not modify application code to make a failing test pass without explicit triage approval from the project owner.

**Convention:** Tests use IDs in format `AREA-N.N.N`. Areas: MF (manifest), WS (workspace), PF (profile), LD (loader), RS (resolution), VL (validation), IN (inspection), EX (export), NS (namespace/promotion), RT (runtime/singleton), BR (browser runtime), CL (CLI general), CR (cnos run), CD (cnos define), CI (cnos init), CG (codegen), CW (watch), CM (migrate), DR (drift), VT (vault), IG (integration), ED (edge cases).

---

## MF — Manifest Loading

### MF-1.1 — Valid manifest loads successfully
**Setup:** `.cnos/cnos.yml` with `version: 1`, `project.name`, `profiles.default: local`.
**Expected:** Manifest loads without error. `project.name` is accessible.

### MF-1.2 — Missing manifest → clear error
**Setup:** No `.cnos/cnos.yml` file exists.
**Expected:** Error message contains `.cnos/cnos.yml` and `not found`.

### MF-1.3 — Invalid YAML → clear error
**Setup:** `.cnos/cnos.yml` contains malformed YAML (unclosed bracket).
**Expected:** Error message contains `parse` or `syntax`.

### MF-1.4 — Missing version field → error
**Setup:** Manifest without `version:`.
**Expected:** Error: `Missing required field: version`.

### MF-1.5 — Missing project.name → error
**Setup:** Manifest with `version: 1` but no `project.name`.
**Expected:** Error.

### MF-1.6 — Optional sections default gracefully
**Setup:** Manifest with only `version`, `project.name`.
**Expected:** Loads successfully. Profiles default to `local`. No workspaces block = implicit single workspace. No schema = no validation. No envMapping = no env exports.

### MF-1.7 — Extra unknown top-level keys → warning, not error
**Setup:** Manifest with `customField: true` at root.
**Expected:** Loads successfully with warning about unknown field.

### MF-1.8 — .cnos-workspace.yml loads
**Setup:** `.cnos-workspace.yml` with `workspace: api`.
**Expected:** Workspace file loads. `workspace` field accessible.

### MF-1.9 — .cnos-workspace.yml with invalid YAML → error
**Expected:** Clear parse error.

### MF-1.10 — .cnos-workspace.yml missing → no error
**Expected:** Workspace selection falls through to manifest default.

---

## WS — Workspace

### WS-1.1 — Workspace selection: CLI wins over all
**Setup:** CLI `--workspace api`, `.cnos-workspace.yml` has `workspace: db`, manifest default `web`.
**Expected:** Selected workspace = `api`. `workspaceSource` = `"cli"`.

### WS-1.2 — Workspace selection: workspace file wins over manifest
**Setup:** No CLI flag. `.cnos-workspace.yml` has `workspace: db`. Manifest default `web`.
**Expected:** `db`. Source = `"workspace-file"`.

### WS-1.3 — Workspace selection: manifest default
**Setup:** No CLI flag, no workspace file. Manifest `workspaces.default: web`.
**Expected:** `web`. Source = `"manifest-default"`.

### WS-1.4 — Workspace selection: implicit fallback to project.name
**Setup:** No `workspaces` block at all. `project.name: my-service`.
**Expected:** Workspace = `my-service`. Source = `"implicit"`.

### WS-1.5 — Selected workspace not in items → error
**Setup:** `workspaces.items: { api: {}, db: {} }`. Selected = `web`.
**Expected:** Error: `Workspace "web" not found in workspaces.items`.

### WS-1.6 — Workspace inheritance: child extends parent
**Setup:** `base: {}`, `api: { extends: [base] }`. Selected = `api`.
**Expected:** `workspaceChain` = `["base", "api"]`.

### WS-1.7 — Workspace inheritance: multi-level
**Setup:** `root: {}`, `base: { extends: [root] }`, `api: { extends: [base] }`.
**Expected:** Chain = `["root", "base", "api"]`.

### WS-1.8 — Workspace inheritance: cycle detection
**Setup:** `a: { extends: [b] }`, `b: { extends: [a] }`.
**Expected:** Error containing `cycle`.

### WS-1.9 — Workspace inheritance: self-reference cycle
**Setup:** `api: { extends: [api] }`.
**Expected:** Error containing `cycle`.

### WS-1.10 — Workspace inheritance: diamond is OK (not a cycle)
**Setup:** `base: {}`, `a: { extends: [base] }`, `b: { extends: [base] }`, `api: { extends: [a, b] }`.
**Expected:** No error. Chain resolved correctly with `base` appearing once.

### WS-1.11 — Global root selection: CLI wins
**Setup:** CLI `--global-root /tmp/cnos`, workspace file has `~/.cnos`, manifest has `~/alt`.
**Expected:** Global root = `/tmp/cnos`. Source = `"cli"`.

### WS-1.12 — Global root: workspace file wins over manifest
**Setup:** Workspace file `globalRoot: ~/.cnos`. Manifest `workspaces.global.root: ~/alt`.
**Expected:** `~/.cnos`.

### WS-1.13 — Global root: CNOS_HOME as last resort
**Setup:** `process.env.CNOS_HOME = "/home/user/.cnos"`. No other global root config.
**Expected:** Global root = `/home/user/.cnos`. Source = `"CNOS_HOME"`.

### WS-1.14 — Global root NOT activated without enabled: true
**Setup:** `workspaces.global.root: ~/.cnos` but `enabled: false` (or absent).
**Expected:** Global root is NOT used. `globalEnabled` = `false`.

### WS-1.15 — CNOS_HOME alone does not activate global
**Setup:** `process.env.CNOS_HOME = "/x"`. No `workspaces.global.enabled`.
**Expected:** Global NOT active.

### WS-1.16 — Effective root order: global parent → global active → local parent → local active
**Setup:** `api` extends `base`. Global enabled. Both global and local have `base/` and `api/`.
**Expected:** `workspaceRoots` order: global-base, global-api, local-base, local-api.

### WS-1.17 — Implicit single-workspace mode
**Setup:** No `workspaces` block. Single `.cnos/` root with flat layout.
**Expected:** One effective root. Workspace = `project.name`. Everything works as non-workspace setup.

### WS-1.18 — WorkspaceContext populated correctly
**Setup:** Workspace `api` extends `base`, global enabled.
**Action:** Access `cnos.graph.workspace`.
**Expected:** `workspaceId`, `workspaceSource`, `globalRoot`, `globalEnabled`, `workspaceChain`, `workspaceRoots` all populated.

---

## PF — Profile

### PF-1.1 — Profile selection: CLI wins
**Setup:** CLI `--profile stage`, `CNOS_PROFILE=prod`, manifest default `local`.
**Expected:** Profile = `stage`.

### PF-1.2 — Profile selection: env var wins over manifest
**Setup:** `CNOS_PROFILE=prod`, manifest default `local`.
**Expected:** `prod`.

### PF-1.3 — Profile selection: manifest default
**Setup:** No CLI, no env var. `profiles.default: local`.
**Expected:** `local`.

### PF-1.4 — Profile inheritance: parent first
**Setup:** `local` extends `base`. `base` activates `values: [base]`. `local` activates `values: [base, local]`.
**Expected:** Profile chain = `["base", "local"]`. Values from `base/` loaded before `local/`.

### PF-1.5 — Profile inheritance: cycle detection
**Setup:** `a` extends `b`, `b` extends `a`.
**Expected:** Error containing `cycle`.

### PF-1.6 — Profile with no extends → single-element chain
**Setup:** Profile `local` with no `extends`.
**Expected:** Chain = `["local"]`.

### PF-1.7 — Profile activates specific value directories
**Setup:** Profile `stage` activates `values: [base, stage]`.
**Expected:** Only `values/base/` and `values/stage/` are read. `values/local/` is NOT read.

### PF-1.8 — Profile activates env files
**Setup:** Profile `local` activates `envFiles: [.env, .env.local]`.
**Expected:** Both env files loaded.

---

## LD — Loaders

### LD-1.1 — Filesystem values: nested YAML → flat value.* keys
**Setup:** `values/local/app.yml` contains `{ server: { port: 3000, host: "localhost" } }`.
**Expected:** Entries: `value.server.port` = `3000`, `value.server.host` = `"localhost"`.

### LD-1.2 — Filesystem values: provenance includes file path
**Expected:** Each entry's `origin.file` matches the source YAML file path.

### LD-1.3 — Filesystem values: provenance includes workspaceId
**Expected:** Each entry's `workspaceId` matches the workspace that contributed it.

### LD-1.4 — Filesystem values: only reads activated profile directories
**Setup:** Profile activates `[base, local]`. `values/stage/` also exists.
**Expected:** `values/stage/` is NOT read.

### LD-1.5 — Filesystem secrets: nested YAML → flat secret.* keys
**Setup:** `secrets/local/app.yml` contains `{ db: { password: "s3cr3t" } }`.
**Expected:** `secret.db.password` = `"s3cr3t"`.

### LD-1.6 — Filesystem secrets: vault ref YAML → resolved secret
**Setup:** `secrets/local/app.yml` contains `{ db: { password: { provider: local, vault: default, ref: db.password } } }`.
**Expected:** Secret resolved through vault provider.

### LD-1.7 — Dotenv: reads .env file
**Setup:** `.env` contains `DATABASE_HOST=localhost`. `envMapping.explicit: { DATABASE_HOST: value.db.host }`.
**Expected:** `value.db.host` = `"localhost"`.

### LD-1.8 — Dotenv: convention mapping when no explicit
**Setup:** `envMapping.convention: SCREAMING_SNAKE`. `.env` has `SERVER_PORT=3000`. No explicit mapping for `SERVER_PORT`.
**Expected:** `value.server.port` = `"3000"` (convention-derived).

### LD-1.9 — Dotenv: explicit mapping overrides convention
**Setup:** Convention active. `envMapping.explicit: { SERVER_PORT: value.custom.port }`. `.env` has `SERVER_PORT=3000`.
**Expected:** `value.custom.port` = `"3000"`, NOT `value.server.port`.

### LD-1.10 — Dotenv: unmapped var ignored
**Setup:** `.env` has `RANDOM_VAR=x`. No explicit mapping, convention can't map it.
**Expected:** No entry created for `RANDOM_VAR`.

### LD-1.11 — Process env: maps same as dotenv
**Setup:** `process.env.DATABASE_HOST = "prod-db"`. Same explicit mapping.
**Expected:** `value.db.host` = `"prod-db"`.

### LD-1.12 — CLI args: direct key override
**Setup:** CLI arg `--value.server.port=9999`.
**Expected:** `value.server.port` = `9999`.

### LD-1.13 — CLI args: secret override
**Setup:** `--secret.db.password=override`.
**Expected:** `secret.db.password` = `"override"`.

### LD-1.14 — Loaders read from all effective workspace roots
**Setup:** Global `base` has `value.shared.key` = `"global"`. Local `api` has `value.app.key` = `"local"`.
**Expected:** Both keys present in resolved graph.

### LD-1.15 — Dotenv reads from each workspace root's env/ directory
**Setup:** Global workspace has `.env` with `X=global`. Local workspace has `.env` with `X=local`.
**Expected:** Local wins (higher priority root).

### LD-1.16 — Empty YAML file → no entries, no error
**Setup:** `values/local/app.yml` is empty.
**Expected:** No entries from that file. No crash.

### LD-1.17 — Non-existent source directory → no entries, no error
**Setup:** Profile activates `values: [staging]` but `values/staging/` doesn't exist.
**Expected:** No entries. No crash.

---

## RS — Resolution

### RS-1.1 — Precedence: filesystem < dotenv < process-env < cli-args
**Setup:** `value.server.port` defined in all four sources with values `1000`, `2000`, `3000`, `4000`.
**Expected:** Resolved value = `4000` (CLI args wins).

### RS-1.2 — Precedence: within filesystem, local > global
**Setup:** Global has `value.x` = `"global"`. Local has `value.x` = `"local"`.
**Expected:** `"local"`.

### RS-1.3 — Precedence: within filesystem, child workspace > parent
**Setup:** Parent workspace has `value.x` = `"parent"`. Child has `value.x` = `"child"`.
**Expected:** `"child"`.

### RS-1.4 — Deep merge: nested objects merge
**Setup:** Source A: `{ server: { port: 3000 } }`. Source B: `{ server: { host: "localhost" } }`.
**Expected:** Resolved: `value.server.port` = `3000` AND `value.server.host` = `"localhost"`.

### RS-1.5 — Scalars: last writer wins
**Setup:** Source A: `value.x` = `1`. Source B (higher precedence): `value.x` = `2`.
**Expected:** `2`.

### RS-1.6 — Arrays: replace policy (default)
**Setup:** `resolution.arrayPolicy: replace`. Source A: `value.hosts` = `["a"]`. Source B: `value.hosts` = `["b", "c"]`.
**Expected:** `["b", "c"]`.

### RS-1.7 — Missing key: read() returns undefined
**Expected:** `cnos.read("value.nonexistent")` → `undefined`.

### RS-1.8 — Missing key: require() throws
**Expected:** `cnos.require("value.nonexistent")` → throws `CnosKeyNotFoundError`.

### RS-1.9 — Missing key: readOr() returns fallback
**Expected:** `cnos.readOr("value.nonexistent", 42)` → `42`.

### RS-1.10 — Profile-specific values override base
**Setup:** Base profile: `value.log.level` = `"info"`. Local profile: `value.log.level` = `"debug"`.
**Expected:** `"debug"`.

### RS-1.11 — Resolution is deterministic
**Action:** Resolve the same config twice with identical inputs.
**Expected:** Byte-identical resolved graph (ignoring `resolvedAt` timestamp).

---

## VL — Validation

### VL-1.1 — Schema: required key present → pass
**Setup:** Schema `value.port: { required: true }`. Key exists.
**Expected:** Validation passes.

### VL-1.2 — Schema: required key missing → fail
**Setup:** Schema `value.port: { required: true }`. Key absent.
**Expected:** Failure: `Required key "value.port" is missing`.

### VL-1.3 — Schema: type number, actual string → fail
**Setup:** Schema `value.port: { type: number }`. Actual value = `"3000"` (string).
**Expected:** Failure: type mismatch.

### VL-1.4 — Schema: type string, actual string → pass
**Expected:** Pass.

### VL-1.5 — Schema: enum check
**Setup:** Schema `value.env: { enum: ["dev", "stage", "prod"] }`. Actual = `"test"`.
**Expected:** Failure: value not in enum.

### VL-1.6 — Schema: pattern check
**Setup:** Schema `value.email: { pattern: "^.+@.+$" }`. Actual = `"notanemail"`.
**Expected:** Failure.

### VL-1.7 — Schema: default applied when key missing
**Setup:** Schema `value.host: { default: "127.0.0.1" }`. Key not defined.
**Expected:** `value.host` resolves to `"127.0.0.1"`.

### VL-1.8 — Reports all failures, not just first
**Setup:** Three required keys missing.
**Expected:** Error report lists all three.

### VL-1.9 — Workspace graph acyclic → pass
**Expected:** No cycle error.

### VL-1.10 — Profile graph acyclic → pass
**Expected:** No cycle error.

### VL-1.11 — public.promote contains only value.* → pass
**Expected:** No error.

### VL-1.12 — Env mapping collision detected
**Setup:** Two different logical keys map to same env var name via convention.
**Expected:** Warning about collision.

### VL-1.13 — Global write disallowed without allowWrite
**Setup:** Attempt `define --target global`. `workspaces.global.allowWrite: false`.
**Expected:** Error.

---

## IN — Inspection / Provenance

### IN-1.1 — Inspect returns final value
**Expected:** `inspect("value.server.port").value` = resolved value.

### IN-1.2 — Inspect shows winning source
**Expected:** `winner.sourceId` and `winner.pluginId` populated.

### IN-1.3 — Inspect shows workspace context
**Expected:** `workspace.id`, `workspace.source`, `workspace.chain` populated.

### IN-1.4 — Inspect shows profile context
**Expected:** `profile` and `profileSource` populated.

### IN-1.5 — Inspect shows override chain
**Setup:** Key overridden by three sources.
**Expected:** `overridden` array has 2 entries with correct values and sources.

### IN-1.6 — Inspect shows file origin
**Setup:** Value from filesystem loader.
**Expected:** `winner.origin.file` is the YAML file path.

### IN-1.7 — Inspect shows env var origin
**Setup:** Value from process-env loader.
**Expected:** `winner.origin.envVar` populated.

### IN-1.8 — Inspect shows CLI arg origin
**Setup:** Value from CLI args.
**Expected:** `winner.origin.cliArg` populated.

### IN-1.9 — Inspect nonexistent key → clear error
**Expected:** Error: key not found.

---

## NS — Namespaces + Promotion (Pre-Changeset Phase 1)

### NS-1.1 — Namespace defaults applied when no block
**Expected:** `value`, `secret`, `meta`, `public`, `env` all present with correct properties.

### NS-1.2 — Custom namespace in manifest
**Setup:** `namespaces: { flag: { kind: data, shareable: true } }`.
**Expected:** `flag` added alongside defaults.

### NS-1.3 — Cannot weaken secret security via manifest
**Setup:** `namespaces: { secret: { shareable: true } }`.
**Expected:** Error or ignored. `secret` remains `sensitive: true, shareable: false`.

### NS-1.4 — Promoted value creates public.* mirror
**Setup:** `value.app.name` = `"kitsy"`, promoted.
**Expected:** `public.app.name` = `"kitsy"` in graph.

### NS-1.5 — Multiple promoted keys
**Setup:** Three keys promoted.
**Expected:** All three mirrored in `public.*`.

### NS-1.6 — Promoted value preserves type
**Setup:** `value.port` = `3000` (number), promoted.
**Expected:** `public.port` = `3000` (number).

### NS-1.7 — Promoted missing key → no-op
**Setup:** `public.promote: [value.nonexistent]`.
**Expected:** No `public.nonexistent`. No error.

### NS-1.8 — Secret in public.promote → CnosSecurityError
**Expected:** Hard error listing the offending key.

### NS-1.9 — Secret in envMapping.explicit → CnosSecurityError
**Expected:** Hard error.

### NS-1.10 — Multiple security violations → all reported
**Setup:** Two secret keys in promote.
**Expected:** Both listed in error.

### NS-1.11 — cnos.read("public.x") returns promoted value
**Expected:** Correct value.

### NS-1.12 — cnos.read("public.missing") → undefined
**Expected:** `undefined`.

### NS-1.13 — cnos.require("public.missing") → throws
**Expected:** `CnosKeyNotFoundError`.

### NS-1.14 — cnos.toNamespace("public") returns only promoted keys
**Expected:** Subset of promoted values only.

### NS-1.15 — cnos promote CLI: add to public
**Action:** `cnos promote value.x --to public`.
**Expected:** Added to `public.promote` in manifest.

### NS-1.16 — cnos promote CLI: secret → error, no mutation
**Action:** `cnos promote secret.x --to public`.
**Expected:** Error. Manifest unchanged.

### NS-1.17 — cnos promote CLI: duplicate → no duplicate entry
**Action:** Promote already-promoted key.
**Expected:** Still one entry.

### NS-1.18 — cnos promote CLI: to env with --as
**Action:** `cnos promote value.port --to env --as PORT`.
**Expected:** `envMapping.explicit.PORT` added.

### NS-1.19 — cnos promote CLI: to env without --as → error
**Expected:** Error.

### NS-1.20 — Inspect promoted key shows promotion source
**Action:** `cnos inspect public.app.name`.
**Expected:** Shows promoted from `value.app.name`.

---

## EX — Export

### EX-1.1 — toEnv() returns explicit mappings only
**Setup:** `envMapping.explicit: { PORT: value.port }`. Other keys exist but unmapped.
**Expected:** Only `{ PORT: "3000" }`.

### EX-1.2 — toPublicEnv() returns promoted keys only
**Setup:** `value.a` promoted, `value.b` not.
**Expected:** Only `a`-related entries.

### EX-1.3 — toPublicEnv with framework prefix
**Setup:** `public.frameworks.vite: VITE_`. `value.api.url` promoted.
**Expected:** `{ VITE_API_URL: "..." }`.

### EX-1.4 — toPublicEnv never includes secrets
**Expected:** Even if incorrectly promoted (caught by validation), `toPublicEnv` double-checks.

### EX-1.5 — meta.* never in env export
**Expected:** No meta keys in `toEnv()` or `toPublicEnv()`.

### EX-1.6 — --to flag writes file
**Action:** `cnos export env --to .env.out`.
**Expected:** File written. Pure KEY=VALUE format.

### EX-1.7 — --to with profile
**Action:** `cnos export env --profile stage --to .env.stage`.
**Expected:** Stage values in file.

### EX-1.8 — --to with public + framework
**Action:** `cnos export env --public --framework vite --to .env.vite`.
**Expected:** VITE_-prefixed keys in file.

### EX-1.9 — Without --to, stdout output
**Expected:** Output goes to stdout.

### EX-1.10 — Dump: workspace-preserving
**Action:** `cnos dump --workspace api --to ./out`.
**Expected:** `./out/profiles/`, `./out/values/`, `./out/secrets/`, `./out/env/` structure.

### EX-1.11 — Dump: flatten
**Action:** `cnos dump --workspace api --flatten --to ./out`.
**Expected:** Standalone flat structure.

### EX-1.12 — Dump is a snapshot, not live
**Action:** Dump, then change a value, read from dump.
**Expected:** Dump contains old value.

### EX-1.13 — Export values with special characters
**Setup:** Value contains quotes, equals, newlines.
**Expected:** Valid .env format output.

---

## RT — Singleton Runtime (Pre-Changeset Phase 3)

### RT-1.1 — Singleton from __CNOS_GRAPH__: sync read
**Setup:** `process.env.__CNOS_GRAPH__` set.
**Expected:** `cnos("value.port")` returns value synchronously.

### RT-1.2 — Singleton callable as function
**Expected:** `cnos("value.port")` works.

### RT-1.3 — Singleton .read() method
**Expected:** Same as function call.

### RT-1.4 — Singleton .value() convenience
**Expected:** `cnos.value("port")` works.

### RT-1.5 — Singleton .secret() convenience
**Expected:** `cnos.secret("db.password")` works.

### RT-1.6 — Singleton .meta()
**Expected:** `cnos.meta("profile")` works.

### RT-1.7 — Singleton .require() throws on missing
**Expected:** Throws.

### RT-1.8 — Singleton .readOr() fallback
**Expected:** Returns fallback.

### RT-1.9 — Read before ready() without graph → error
**Expected:** Clear message mentioning `cnos.ready()` or `cnos run`.

### RT-1.10 — ready() in standalone mode
**Expected:** Resolves from `.cnos/` directory.

### RT-1.11 — ready() idempotent
**Expected:** No error on double call.

### RT-1.12 — Invalid __CNOS_GRAPH__ → clear error
**Expected:** Message about parsing failure.

### RT-1.13 — Same singleton across imports
**Expected:** Singleton guarantee.

---

## BR — Browser Runtime (Pre-Changeset Phase 4)

### BR-1.1 — Read promoted value
**Expected:** Returns value from embedded data.

### BR-1.2 — Read missing key → undefined
**Expected:** `undefined`.

### BR-1.3 — Require missing key → throws
**Expected:** Error.

### BR-1.4 — Read secret → throws
**Expected:** Error mentioning `secret.*` not available.

### BR-1.5 — Read value.* normalized to public.*
**Expected:** `cnos("value.app.name")` resolves via `public.app.name`.

### BR-1.6 — toObject() returns copy
**Expected:** Mutation of returned object doesn't affect runtime.

### BR-1.7 — No __CNOS_BROWSER_DATA__ → empty, no crash
**Expected:** All reads return undefined.

### BR-1.8 — Invalid JSON in data → clear error
**Expected:** Parse error.

### BR-1.9 — Types preserved (boolean, number)
**Expected:** `true` stays boolean, `3000` stays number.

### BR-1.10 — resolveBrowserData() returns only public.* keys
**Expected:** No secret or non-promoted value keys.

### BR-1.11 — Vite plugin injects data correctly
**Expected:** `globalThis.__CNOS_BROWSER_DATA__` in define output.

### BR-1.12 — Next plugin injects data correctly
**Expected:** Same pattern.

### BR-1.13 — Browser runtime works in Node.js (no crash)
**Expected:** Returns undefined for everything, no browser API assumptions.

---

## CR — cnos run

### CR-1.1 — Injects env vars into child
**Expected:** Child process sees mapped env vars.

### CR-1.2 — Profile override
**Expected:** `--profile stage` uses stage values.

### CR-1.3 — --set override
**Expected:** Inline value override applied.

### CR-1.4 — --public injects only promoted keys
**Expected:** Non-promoted and secret keys absent.

### CR-1.5 — __CNOS_GRAPH__ injected
**Expected:** Child process sees it.

### CR-1.6 — Exit code propagated
**Expected:** CNOS exits with child's code.

### CR-1.7 — stdout/stderr passed through
**Expected:** Piped correctly.

### CR-1.8 — Missing -- separator → error
**Expected:** Clear message.

### CR-1.9 — --workspace flag
**Expected:** Correct workspace used.

### CR-1.10 — Schema validation before spawn
**Setup:** Required key missing.
**Expected:** Error before child spawns.

---

## CD — cnos define

### CD-1.1 — Define value writes to correct file
**Setup:** `writePolicy.define.targets.value: ./values/app.yml`.
**Expected:** File updated.

### CD-1.2 — Define secret writes to correct file
**Expected:** Secret file updated.

### CD-1.3 — Define with profile
**Expected:** Profile-specific file targeted.

### CD-1.4 — Creates file if missing
**Expected:** File created.

### CD-1.5 — Deep-writes YAML path
**Setup:** `cnos define value server.port 3000`.
**Expected:** `{ server: { port: "3000" } }` in YAML.

### CD-1.6 — Preserves existing content
**Setup:** File has other keys.
**Expected:** Other keys untouched.

### CD-1.7 — Namespace/directory safety
**Expected:** Cannot write secret to values/ path.

### CD-1.8 — --target global with allowWrite
**Expected:** Writes to global store.

### CD-1.9 — --target global without allowWrite → error
**Expected:** Error.

### CD-1.10 — Deterministic targeting
**Action:** Same define command twice.
**Expected:** Same file targeted both times.

---

## CI — cnos init

### CI-1.1 — Creates .cnos/ structure
**Expected:** Directory with cnos.yml, profiles/, values/, secrets/, env/.

### CI-1.2 — Generates .gitignore
**Expected:** secrets/ and .cnos-workspace.yml gitignored.

### CI-1.3 — Workspace mode creates subtrees
**Action:** `cnos init --workspaces api,db`.
**Expected:** `workspaces/api/` and `workspaces/db/` structures.

---

## CG — cnos codegen (Changeset Phase 1)

### CG-1.1 — Generates typed interfaces from schema
**Setup:** Schema with value and secret keys.
**Expected:** `CnosValueConfig` and `CnosSecretConfig` interfaces.

### CG-1.2 — Type mapping: number → number
**Expected:** Schema `type: number` → TS `number`.

### CG-1.3 — Type mapping: string → string
**Expected:** Correct.

### CG-1.4 — Type mapping: boolean → boolean
**Expected:** Correct.

### CG-1.5 — Type mapping: object → Record<string, unknown>
**Expected:** Correct.

### CG-1.6 — Type mapping: array → unknown[]
**Expected:** Correct.

### CG-1.7 — Groups by namespace
**Expected:** Value keys in `CnosValueConfig`, secret keys in `CnosSecretConfig`.

### CG-1.8 — No schema → empty interfaces + hint
**Expected:** Generated file has empty interfaces. CLI prints hint.

### CG-1.9 — --out custom path
**Expected:** File written to specified path.

### CG-1.10 — --watch regenerates on change
**Expected:** File change triggers regeneration.

### CG-1.11 — Generated types compile
**Expected:** `tsc --noEmit` succeeds on generated file.

### CG-1.12 — Typed wrapper re-exports createCnos
**Expected:** `runtime.ts` generated alongside types.

---

## CW — cnos watch (Changeset Phase 2)

### CW-1.1 — File change triggers re-resolve
**Expected:** New resolved graph produced.

### CW-1.2 — Changed keys detected
**Expected:** Diff identifies which keys changed.

### CW-1.3 — Restart mode: child restarted
**Expected:** Old process killed, new one spawned.

### CW-1.4 — Signal mode: JSON output
**Expected:** Changed keys printed as JSON to stdout.

### CW-1.5 — Debounce prevents rapid re-fires
**Setup:** 5 changes in 100ms.
**Expected:** Only 1 re-resolve (after 300ms debounce).

### CW-1.6 — cnos.yml change triggers re-resolve
**Expected:** Schema or profile changes detected.

### CW-1.7 — New file in watched dir triggers resolve
**Expected:** New value file detected.

---

## CM — cnos migrate (Changeset Phase 3)

### CM-1.1 — Scans process.env.X
**Setup:** File with `process.env.DATABASE_HOST`.
**Expected:** Extracts `DATABASE_HOST`.

### CM-1.2 — Scans process.env['X']
**Expected:** Bracket notation extracted.

### CM-1.3 — Scans import.meta.env.VITE_X
**Expected:** Extracts `VITE_X`.

### CM-1.4 — Secret detection: _PASSWORD suffix
**Expected:** Proposed as `secret.*`.

### CM-1.5 — Secret detection: _SECRET, _KEY, _TOKEN
**Expected:** All proposed as `secret.*`.

### CM-1.6 — Public detection: NEXT_PUBLIC_ prefix
**Expected:** Proposed for `public.promote`.

### CM-1.7 — Public detection: VITE_ prefix
**Expected:** Same.

### CM-1.8 — --dry-run shows proposal without writing
**Expected:** No file modifications.

### CM-1.9 — --apply writes manifest
**Expected:** `envMapping.explicit` updated.

### CM-1.10 — --apply rewrites source with backup
**Expected:** `.bak` file created. Source rewritten.

### CM-1.11 — Env var → logical key convention
**Expected:** `DATABASE_HOST` → `value.database.host`.

---

## DR — cnos drift (Changeset Phase 4)

### DR-1.1 — Missing required key detected
**Expected:** Listed as missing.

### DR-1.2 — Undeclared key detected
**Expected:** Listed as undeclared.

### DR-1.3 — Type mismatch detected
**Setup:** Schema says number, actual is string.
**Expected:** Mismatch reported.

### DR-1.4 — Default applied → info
**Expected:** Reported as info, not error.

### DR-1.5 — All keys match → clean report
**Expected:** No issues.

### DR-1.6 — --profile scoped
**Expected:** Drift checked against specified profile.

### DR-1.7 — --workspace scoped
**Expected:** Drift checked against specified workspace.

---

## VT — Vault (Pre-Changeset Phase 5)

### VT-1.1 — Create local vault
**Expected:** Manifest updated.

### VT-1.2 — Create github-secrets vault, no passphrase
**Expected:** No passphrase in config.

### VT-1.3 — Vault already exists → error
**Expected:** Error.

### VT-1.4 — List vaults
**Expected:** All vaults listed.

### VT-1.5 — Remove vault
**Expected:** Removed from manifest.

### VT-1.6 — Secret set with vault
**Expected:** Stored.

### VT-1.7 — Secret get from vault
**Expected:** Retrieved.

### VT-1.8 — GitHub provider reads process.env
**Expected:** Correct value.

### VT-1.9 — GitHub provider missing env var → error
**Expected:** Clear error.

---

## IG — Integration (End-to-End)

### IG-1 — Backend: init → define → run → read
**Full flow:** Init, set values, map to env, run child, verify env vars.

### IG-2 — Frontend: define → promote → export vite
**Full flow:** Set value, promote to public, export with VITE_ prefix, verify file.

### IG-3 — CI/CD: profile-specific export
**Full flow:** Set local and stage values, export stage to file, verify.

### IG-4 — Deployment: cnos run --profile prod
**Full flow:** Production profile, inject env, verify child sees prod values.

### IG-5 — Singleton via cnos run
**Full flow:** Run child, child imports singleton, reads synchronously.

### IG-6 — Browser: promote → build embed → browser read
**Full flow:** Promote, build browser data, verify browser runtime reads.

### IG-7 — Workspace + profile + promotion + export
**Full flow:** Workspace api, stage profile, promoted values, export next.

### IG-8 — Doctor validates full system
**Full flow:** Valid config → doctor passes. Then introduce violation → doctor catches.

### IG-9 — Define then read round-trip
**Full flow:** `cnos define value x y` → `cnos read value.x` → outputs `y`.

### IG-10 — Diff between profiles
**Full flow:** Different values in local vs stage → diff shows delta.

### IG-11 — Codegen then compile
**Full flow:** Generate types → import in .ts file → tsc succeeds.

### IG-12 — Migrate then read
**Full flow:** Scan source → apply mappings → values resolve via new mappings.

---

## ED — Edge Cases

### ED-1 — Key with deep dot path: `value.a.b.c.d.e`
**Expected:** Works correctly through all operations.

### ED-2 — Value is empty string
**Expected:** `read()` returns `""`, NOT undefined.

### ED-3 — Value is null
**Expected:** Returns `null`.

### ED-4 — Value is object
**Expected:** Returned as object.

### ED-5 — Value is array
**Expected:** Returned as array.

### ED-6 — Env export of boolean
**Expected:** `MY_FLAG=true` (string).

### ED-7 — Env export of number
**Expected:** `PORT=3000` (string).

### ED-8 — Env export of object → JSON or error
**Expected:** Consistent behavior (document which).

### ED-9 — Value with equals sign
**Expected:** `CONN=host=db;port=5432` (only first `=` is delimiter).

### ED-10 — Value with newlines
**Expected:** Properly escaped in .env.

### ED-11 — Unicode values
**Expected:** `"こんにちは"` preserved everywhere.

### ED-12 — Very long value (10K chars)
**Expected:** No truncation.

### ED-13 — 500 config keys
**Expected:** Resolution and export succeed. __CNOS_GRAPH__ serializes.

### ED-14 — Concurrent profile override in promotion
**Setup:** Key overridden by profile, also promoted.
**Expected:** Promoted value reflects profile override.

### ED-15 — Env var name collision (convention vs explicit)
**Expected:** Explicit wins.

### ED-16 — Empty env file
**Expected:** No entries, no crash.

### ED-17 — Empty values directory
**Expected:** No entries, no crash.

### ED-18 — Manifest with all optional sections empty
**Expected:** Loads with defaults. No crash.

### ED-19 — Workspace with no values/secrets/env directories
**Expected:** Resolves with empty graph for that workspace. No crash.

### ED-20 — Multiple profiles activating overlapping value directories
**Setup:** Profile chain activates `[base, local]`, both have `app.yml` with overlapping keys.
**Expected:** Later in chain wins (local over base).
