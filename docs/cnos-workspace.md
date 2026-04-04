# CNOS v1 — Workspace Model Addition (Clean Replacement Note)

**Purpose:** This document isolates the workspace model that is now treated as first-class in CNOS v1. It is not a backward-compatible patch. It replaces the earlier single-root assumption.

---

## 1. Why Workspace Is Foundational

Workspace support should have been first-class from the beginning because CNOS is intended to serve:

- single-project local setups
- local global-config setups such as `~/.cnos/workspaces/<id>`
- monorepos with multiple apps/services
- future hosted/centralized config systems

In all of these, the critical runtime question is:

> **Which workspace is active for this invocation?**

Once that question exists, workspace cannot be an afterthought. It affects discovery, loading, provenance, write routing, dumping/materialization, and CLI ergonomics.

---

## 2. Core Rules

### 2.1 Local manifest is authoritative
The repo-local manifest remains the control point:

- `.cnos/cnos.yml` is the authoritative manifest
- plugin graph, precedence, public promotion, schema, write policy, and workspace policy are defined there
- global config is a lower-priority data source, never an independent manifest authority in v1

### 2.2 One active workspace per invocation
Every runtime and CLI invocation resolves one active workspace.

Examples:
- `api`
- `db`
- `agents`

### 2.3 Local is first-class
Local repo config is always the primary source of truth for reproducible builds and deployments.

Global config exists to centralize config management and to prepare for future hosted/server-backed config, but global config is only read when explicitly enabled by the local manifest and selected workspace policy.

### 2.4 Global is opt-in
Global config is not auto-consumed.

Global workspace roots are active only when:
- the local manifest enables them
- and a global root resolves from CLI, `.cnos-workspace.yml`, manifest, or `CNOS_HOME`

`CNOS_HOME` alone does not activate global loading.

### 2.5 Workspace inheritance is separate from profile inheritance
- workspace inheritance composes config trees
- profile inheritance activates environment layers within the selected workspace

These are separate graphs.

### 2.6 Dump/materialize is explicit
Workspace materialization is not an overloaded form of env export.

Use:
- `cnos export env` for env projection
- `cnos dump` for filesystem materialization

---

## 3. Files Added / Changed

### 3.1 Authoritative manifest
- `.cnos/cnos.yml`

### 3.2 Repo-local workspace override file
- `.cnos-workspace.yml`

This file is intentionally small and only supports repo-local workspace selection and global-root override.

Example:

```yaml
workspace: api
globalRoot: ~/.cnos
```

It is not a second manifest.

---

## 4. Workspace Terminology

Use a structured `workspaces` block in the manifest:

```yaml
workspaces:
  default: api

  global:
    enabled: true
    root: ~/.cnos
    allowWrite: true

  items:
    base: {}
    api:
      extends: [base]
      globalId: api
    db:
      extends: [base]
    agents:
      extends: [base]
```

### Meaning
- `default`: default active workspace
- `global.enabled`: whether global fallback is active
- `global.root`: optional default global root
- `global.allowWrite`: whether CLI writes may explicitly target global
- `items.<id>.extends`: workspace inheritance graph
- `items.<id>.globalId`: optional global workspace alias

---

## 5. Discovery Order

### 5.1 Active workspace
Workspace is resolved in this order:

1. CLI `--workspace`
2. `.cnos-workspace.yml`
3. `workspaces.default`
4. implicit single-workspace fallback to `project.name` only when no explicit `workspaces.items` exist

### 5.2 Global root
Global root resolves in this order:

1. CLI `--global-root`
2. `.cnos-workspace.yml`
3. `workspaces.global.root`
4. `CNOS_HOME`

Global root is used only if `workspaces.global.enabled: true`.

---

## 6. WorkspaceContext

CNOS introduces a first-class `WorkspaceContext`.

```ts
interface WorkspaceContext {
  workspaceId: string;
  workspaceSource: "cli" | "workspace-file" | "manifest-default" | "implicit";
  globalRoot?: string;
  globalRootSource?: "cli" | "workspace-file" | "manifest" | "CNOS_HOME";
  workspaceChain: string[]; // parents first, selected workspace last
  workspaceRoots: Array<{
    scope: "global" | "local";
    workspaceId: string;
    path: string;
  }>;
}
```

This is resolved before profile expansion.

---

## 7. Filesystem Layout

### 7.1 Local repo layout

```text
.cnos/
  cnos.yml
  workspaces/
    api/
      profiles/
      values/
      secrets/
      env/
    db/
      profiles/
      values/
      secrets/
      env/
    agents/
      profiles/
      values/
      secrets/
      env/
```

### 7.2 Global root layout

```text
~/.cnos/
  workspaces/
    api/
      profiles/
      values/
      secrets/
      env/
    db/
      profiles/
      values/
      secrets/
      env/
```

This keeps local and global trees structurally identical.

---

## 8. Root Ordering for Loaders

Loaders no longer consume one `cnosRoot`.

They consume an ordered workspace-root list.

Effective order:

1. global parent workspaces
2. global active workspace
3. local parent workspaces
4. local active workspace

Then, within each root, normal profile activation applies.

This ensures:
- parents before child
- global before local
- local active workspace wins last
- existing loader precedence still applies inside the data loaded from those roots

---

## 9. LoaderContext Change

Replace the single-root assumption with this structure:

```ts
interface LoaderContext {
  manifestConfig: Record<string, unknown>;
  profile: string;
  profileChain: string[];
  manifestRoot: string; // repo-local .cnos/
  workspace: WorkspaceContext;
  cliArgs?: string[];
  processEnv?: Record<string, string | undefined>;
}
```

Key distinction:
- `manifestRoot` = where authoritative manifest lives
- `workspace.workspaceRoots` = where config data is actually loaded from

---

## 10. Global Read and Write Policy

### 10.1 Reads
Global roots are readable only when:
- enabled by manifest
- root is resolved
- selected workspace resolves there

### 10.2 Writes
Global writes are supported in v1, but must be explicit and deterministic.

Default:
- `define` writes to local selected workspace

Explicit global write:
```bash
cnos define value "server.port" "8080" --workspace api --target global
```

Guardrails:
- manifest must have `workspaces.global.allowWrite: true`
- global root must resolve
- target workspace must resolve
- writes remain deterministic through declared write policy
- local remains the default target to preserve reproducibility

This gives early support for global authoring without weakening local-first deployment determinism.

---

## 11. Dump / Materialization

Use `cnos dump` for materialization.

### 11.1 Workspace-preserving dump
```bash
cnos dump --workspace api --to ./.cnos/workspaces/api
```

### 11.2 Standalone flatten dump
```bash
cnos dump --workspace api --flatten --to ./.cnos
```

Semantics:
- dump materializes a snapshot of the selected effective workspace
- snapshot is not a live redirect
- dump is the bridge between centralized/global config and deployment-local config

This is essential for reproducible deploys and future hosted/server-backed flows.

---

## 12. Provenance and Meta Additions

Workspace-aware provenance becomes first-class.

Recommended additions:

- `meta.workspace`
- `meta.workspace.source`
- `meta.workspace.chain`
- `meta.globalRoot`
- `meta.global.enabled`

`inspect()` output should include workspace context.

---

## 13. Test Implications

At minimum, add tests for:

- workspace selection: CLI > `.cnos-workspace.yml` > manifest default > implicit project name
- global root selection: CLI > `.cnos-workspace.yml` > manifest > `CNOS_HOME`
- workspace inheritance order
- workspace cycle detection
- global-disabled behavior
- local-over-global layering
- global explicit write target
- `dump` snapshot behavior
- provenance includes workspace metadata

---

## 14. Final Position

Workspace is not an optional extension in CNOS v1.

The correct CNOS mental model is now:

> **One authoritative local manifest, one active workspace per invocation, optional global lower-priority workspace roots, explicit dump/materialization, and deterministic local-first behavior.**
