# CNOS v2 — Architecture Addendum (Diff Against v1)

**Purpose:** This document describes what changes from v1 to v2 and why. It is a diff reference, not a standalone spec.

---

## Summary

v1 is a strong working system. v2 does not replace the resolution model. v2 makes three architectural shifts:

1. **Manifest simplification** — fewer top-level sections, self-contained concepts, optional `config.ts` as an alternative to YAML.
2. **Streams as a user-facing feature** — input source groups with enablement and lifecycle, exposed when real remote loaders ship.
3. **Surfaces as a user-facing feature** — named output projections that make the server/browser boundary explicit and auditable.

v2 only ships streams/surfaces as user-facing config when there is at least one real remote loader to motivate them. Until then, the internal stream tagging and hardcoded server/browser surfaces from v1 are sufficient.

---

## 1. Manifest Simplification

### Problem

The v1 manifest has twelve potential top-level sections. For a config tool, the config file carries too much cognitive load.

### v2 approach

Collapse related sections. Make the manifest scannable in under 30 seconds.

**v1 sections (12):** `project`, `workspaces`, `profiles`, `plugins`, `sources`, `resolution`, `envMapping`, `public`, `writePolicy`, `schema`, `namespaces`, `surfaces`

**v2 sections (7):** `project`, `workspaces`, `profiles`, `config`, `env`, `public`, `schema`

| v1 | v2 | Change |
|----|-----|--------|
| `plugins` + `sources` + `resolution` | `config` | Merged — loaders, precedence, array policy live under one key |
| `envMapping` | `env` | Renamed; `env.export` replaces `envMapping.explicit` |
| `writePolicy` | `config.write` | Moved inside `config` |
| Everything else | Same | Unchanged |

**v2 simple manifest:**

```yaml
version: 2
project:
  name: my-service

profiles:
  default: local

config:
  precedence: [files, dotenv, env, cli]
  write:
    defaultProfile: local
    targets:
      value: ./values/{profile}/app.yml
      secret: ./secrets/{profile}/app.yml

env:
  convention: SCREAMING_SNAKE
  export:
    DATABASE_HOST: value.db.host
    DATABASE_PASSWORD: secret.db.password

public:
  promote: [value.api.baseUrl]
  frameworks:
    next: NEXT_PUBLIC_
    vite: VITE_

schema:
  value.server.port: { type: number, required: true }
  value.api.baseUrl: { type: string, required: true }
  secret.db.password: { type: string, required: true }
```

### `config.ts` alternative

v2 supports `.cnos/config.ts` as an alternative to `cnos.yml`:

```ts
import { defineConfig } from "@kitsy/cnos";

export default defineConfig({
  project: { name: "my-service" },
  profiles: { default: "local" },
  config: { precedence: ["files", "dotenv", "env", "cli"] },
  env: { convention: "SCREAMING_SNAKE", export: { DATABASE_HOST: "value.db.host" } },
  public: { promote: ["value.api.baseUrl"], frameworks: { next: "NEXT_PUBLIC_" } },
  schema: { "value.server.port": { type: "number", required: true } },
});
```

CNOS checks for `config.ts` first, then `cnos.yml`. Only one is authoritative.

---

## 2. Streams (User-Facing)

**Precondition:** Ships only when at least one real remote loader plugin exists.

The `config` block gains an optional `streams` sub-key:

```yaml
config:
  precedence: [local, github, firebase, env]
  streams:
    local:
      loaders: [filesystem-values, filesystem-secrets, dotenv]
      enabled: always
    github:
      loader: github-secrets
      token: ${GITHUB_TOKEN}
      ref: v2.3.1
      enabled: { when: CI }
    firebase:
      loader: firebase-remote-config
      projectId: my-project
      namespace: flag
      refresh: { strategy: lazy, ttl: 300 }
    env:
      loaders: [process-env, cli-args]
      enabled: always
```

No `streams` → auto-generates implicit streams from defaults. Zero migration.

Enablement: `always` or `{ when: ENV_VAR }` (truthy check, no expression engine).

---

## 3. Surfaces (User-Facing)

**Precondition:** Ships when the browser runtime and at least one custom namespace exist.

```yaml
surfaces:
  server:
    namespaces: [value, secret, meta, flag]
  browser:
    namespaces: [value, flag]
    filter: public.promote
```

No `surfaces` → implicit surfaces matching v1 behavior.

---

## 4. Custom Namespaces

**Precondition:** Ships alongside the first remote loader producing non-value/non-secret data.

```yaml
namespaces:
  flag:
    source: firebase
    promotable: true
    sensitive: false
```

Built-in namespaces always present. Custom namespaces tied to source streams. Sensitive namespaces never promotable.

---

## 5. CLI as Primary Adoption Surface

v2 onboarding prioritizes CLI over runtime API:

```bash
cnos init
cnos value set server.port 3000
cnos run -- node server.js       # zero code change
cnos codegen                     # opt-in typed access
```

`cnos run` is the hero command. Programmatic access is optional depth.

---

## 6. What Does NOT Change

Workspace model, profile model, write policy semantics, dump/run/diff/doctor, secret vaults, `.cnos-workspace.yml`, local-first authority, all hard constraints.

---

## 7. What Gets Pulled Into v1

| Feature | Status |
|---------|--------|
| `cnos codegen` | v1 — pure DX, no arch change |
| `cnos watch` | v1 — CLI addition |
| `cnos migrate` | v1 — CLI addition |
| `.env` export `--to` | v1 — trivial flag |
| `cnos drift` | v1 — validation extension |
| Singleton runtime | v1 — additive export |
| Internal stream tagging | v1 — internal refactor |
| Browser runtime (hardcoded) | v1 — two fixed surfaces |

What remains v2-only: manifest simplification, `config.ts`, user-facing streams, user-facing surfaces, custom namespaces, bundler plugin contract.
