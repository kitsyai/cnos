# CNOS v1 — Codex Bootstrap Prompt (Workspace-Integrated)

You are implementing CNOS from a fresh start. This is a new implementation with no legacy compatibility.

## Authority

The canonical spec is `docs/cnos-spec.md`.

This prompt tells you what to build and in what order.  
If this prompt and the spec conflict, the spec wins.

---

## What CNOS Is

CNOS is a configuration resolution system.

Mental model:

```text
Sources → Loader plugins → CNOS core (workspace, namespace, resolve, validate) → Projections / Exports / Read APIs
```

Application code reads logical keys like:
- `value.inventory.db.host`
- `secret.inventory.db.password`

CNOS decides where values come from and how they are resolved. Plugins extend both sides.

Workspace is first-class in v1.

That means:
- one authoritative local manifest: `.cnos/cnos.yml`
- one active workspace per invocation
- local repo config is first-class and deployment-authoritative
- global roots are optional lower-priority data sources
- workspace resolution happens before profile resolution
- `dump` is separate from env export
- global writes are supported only through explicit target mode
- first-party framework integrations can consume the same public export graph without inventing separate config roots

---

## Packages

Create these packages in the pnpm monorepo workspace:

```text
packages/
  cnos/
  cli/
  vite/
  next/
```

Published as:
- `@kitsy/cnos`
- `@kitsy/cnos-cli`
- `@kitsy/cnos-vite`
- `@kitsy/cnos-next`

---

## Implementation Order

Build in this exact sequence. Each phase should pass its tests before moving on.

### Phase 1 — Workspace Foundation + Filesystem Loaders

Build:
1. All types from the canonical spec, including:
   - `LogicalKey`
   - `NamespaceName`
   - `ConfigEntry`
   - `ResolvedEntry`
   - `ResolvedGraph`
   - all plugin interfaces
   - `WorkspaceContext`
2. Manifest loader for `.cnos/cnos.yml`
3. `.cnos-workspace.yml` loader
4. Workspace context resolution:
   - workspace selection precedence:
     1. CLI `--workspace`
     2. `.cnos-workspace.yml`
     3. `workspaces.default`
     4. implicit `project.name` only if `workspaces.items` is absent
   - global root precedence:
     1. CLI `--global-root`
     2. `.cnos-workspace.yml`
     3. `workspaces.global.root`
     4. `CNOS_HOME`
   - activate global only when `workspaces.global.enabled: true`
5. Workspace inheritance expansion and cycle detection
6. `filesystem-values` loader using ordered workspace roots
7. `filesystem-secrets` loader using ordered workspace roots
8. Resolver in flat mode with workspace already resolved
9. Runtime:
   - `read`
   - `require`
   - `readOr`
10. Meta key population:
   - `meta.profile`
   - `meta.cnos.version`
   - `meta.resolved.at`
   - `meta.resolved.from`
   - `meta.workspace`
   - `meta.workspace.source`
   - `meta.workspace.chain`
   - `meta.globalRoot`
   - `meta.global.enabled`

Test:
- manifest loads
- workspace file loads
- workspace selection precedence works
- workspace cycle detection works
- local-only workspace resolution works
- filesystem loaders produce correct namespaced keys
- runtime reads work
- meta keys are populated

### Phase 2 — Remaining Loaders + Precedence + Provenance

Build:
1. `dotenv` loader
2. `process-env` loader
3. `cli-args` loader
4. convention-based env mapping (`SCREAMING_SNAKE`) + explicit overrides
5. full precedence pipeline
6. provenance inspector with workspace-aware output

Test:
- env mapping works both ways
- precedence works
- inspect shows workspace-aware winner and override chain
- local overrides global
- child workspace overrides parent

### Phase 3 — Profiles + Exporters + Dump

Build:
1. profile chain expansion and cycle detection
2. profile-aware resolver integrating workspace + profile
3. `toEnv()` using explicit env mappings only
4. `toPublicEnv()`
5. public promotion validation
6. `toObject()`
7. `toNamespace()`
8. convenience helpers:
   - `value()`
   - `secret()`
   - `meta()`
9. `dump` exporter/materializer:
   - workspace-preserving dump
   - flatten dump

Test:
- profile inheritance works
- public promotion exports only promoted `value.*`
- `secret.*` in promotion is a hard error
- `dump --flatten` writes standalone snapshot tree
- `dump` snapshot is deterministic

### Phase 4 — CLI

Build all commands with workspace support:

1. `cnos init`
2. `cnos read <logical-key>`
3. `cnos value <path>`
4. `cnos secret <path>`
5. `cnos define <namespace> <path> <value>`
6. `cnos inspect <logical-key>`
7. `cnos validate`
8. `cnos export env`
9. `cnos dump`
10. `cnos run -- <command>`
11. `cnos diff`
12. `cnos doctor`
13. `cnos use show`
14. `cnos list env`
15. `cnos list public`
16. `cnos vault create <name> --passphrase <value>`
17. `cnos vault create github-ci --provider github-secrets --no-passphrase`
17. concise error output by default, stack traces only with `--verbose`

All relevant commands must accept:
- `--workspace`
- `--profile`
- `--global-root` where relevant

`define` rules:
- default target is local selected workspace
- explicit global write only with `--target global`
- global write requires `workspaces.global.allowWrite: true`
- write routing must be deterministic

Test:
- commands honor workspace
- `define` local write works
- `define --target global` works
- `dump` works in both modes
- `run` injects resolved env
- `doctor` reports workspace/global issues clearly
- `list value` excludes ambient process env winners
- `list env` shows only explicit env exports
- vault-backed local secrets work end to end

### Phase 5 — Validation + Polish

Build:
1. basic schema validator
2. public safety validator
3. workspace safety validator
4. full test suite
5. README and starter example

---

## Hard Constraints

These are non-negotiable:

1. local manifest is authoritative
2. workspace resolves before profile
3. `secret.*` must never appear in public export
4. there is no `public.*` namespace
5. global roots are opt-in only
6. global writes must be explicit, never implicit
7. `dump` is separate from env export
8. CLI write routing must be deterministic
9. loader/plugin boundaries must remain intact
10. local remains deployment-authoritative even when global is enabled

---

## Key Behaviors to Get Right

### Manifest authority
- only repo-local `.cnos/cnos.yml` defines the active system behavior
- global roots are data sources only in v1

### Workspace layout
Local:
```text
.cnos/
  cnos.yml
  workspaces/
    api/
      profiles/
      values/
      secrets/
      env/
```

Global:
```text
~/.cnos/
  workspaces/
    api/
      profiles/
      values/
      secrets/
      env/
```

### Effective root order
1. global parent workspaces
2. global active workspace
3. local parent workspaces
4. local active workspace

### LoaderContext
Use:
- `manifestRoot`
- `workspace: WorkspaceContext`

Do not use a single `cnosRoot` assumption.

### Public promotion
- read `public.promote`
- export only promoted `value.*`
- reject `secret.*` promotion always

### Secret vault behavior
- local secret material lives outside the repo under `~/.cnos/secrets`
- repo YAML stores only secret refs
- local refs use `provider: local`, `vault`, and a simple logical `ref`
- vault passphrases are vault-scoped and may come from env
- manifest-defined providers may change resolution behavior; `github-secrets` resolves refs from `process.env`

### Global write behavior
Only allow:
```bash
cnos define value "server.port" "8080" --workspace api --target global
```

And only when manifest allows it.

### Dump behavior
Use:
```bash
cnos dump --workspace api --to ./.cnos/workspaces/api
cnos dump --workspace api --flatten --to ./.cnos
```

Do not overload `export` for this.

---

## Module Structure

Follow the canonical spec module layout, including workspace modules:

```text
packages/core/src/
  index.ts
  types/
    core.ts
    plugin.ts
    manifest.ts
    workspace.ts
    profile.ts
    schema.ts
    export.ts
  manifest/
    loadManifest.ts
    normalizeManifest.ts
    loadWorkspaceFile.ts
  workspaces/
    resolveWorkspaceContext.ts
    expandWorkspaceChain.ts
  profiles/
    resolveActiveProfile.ts
    expandProfileChain.ts
  orchestrator/
    createCnos.ts
    runtime.ts
    pipeline.ts
  loaders/
    filesystemValues.ts
    filesystemSecrets.ts
    dotenv.ts
    processEnv.ts
    cliArgs.ts
  resolvers/
    profileAwareResolver.ts
  validators/
    basicSchema.ts
    publicSafety.ts
    workspaceSafety.ts
  exporters/
    toEnv.ts
    toPublicEnv.ts
    dump.ts
  inspectors/
    provenance.ts
  utils/
    path.ts
    flatten.ts
    deepMerge.ts
    yaml.ts
    envNaming.ts
```

---

## Testing Checklist

At minimum, include tests for:

- manifest loads
- workspace file loads
- workspace selection precedence
- global root resolution precedence
- workspace graph cycle detection
- local-only mode
- local + global layering where local wins
- parent + child workspace layering
- filesystem values -> `value.*`
- filesystem secrets -> `secret.*`
- dotenv/process-env/cli-args precedence
- profile resolution
- profile graph cycles
- `inspect()` includes workspace-aware provenance
- `toPublicEnv()` exports only promoted `value.*`
- `secret.*` in public promote -> error
- `define` local write target resolution
- `define --target global` requires permission and resolves correctly
- `dump --flatten` writes deterministic snapshot
- `run` injects resolved env
- meta workspace keys are populated

---

## Style

- production-oriented, readable code
- small, focused modules
- explicit interfaces
- explicit error messages
- comments only for non-obvious behavior
- no premature abstraction
- TypeScript strict mode
