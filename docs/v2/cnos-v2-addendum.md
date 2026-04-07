# CNOS v2 — Architecture Addendum (Diff Against v1 Spec)

**Purpose:** This document describes what changes from the v1 spec to v2, why, and the exact impact on each part of the system. It is a diff reference, not a standalone spec.

---

## Summary of Change

v1 treated CNOS as a monolithic resolution pipeline: loaders feed a single resolver, which produces one graph, consumed by a single runtime.

v2 introduces **named input streams**, **named output surfaces**, **custom namespaces**, and **explicit multi-runtime support** (server, browser, SSR). The core resolution model is unchanged — streams are a compositional layer on top of the existing loader→resolver→graph pipeline.

The mental model evolves from:

```
Sources → Loaders → CNOS core → Exports/APIs
```

To:

```
Named Input Streams → CNOS core (merge, namespace, resolve) → Named Output Surfaces → Runtime modules
```

---

## 1. Named Input Streams

### What changes

v1 has a flat list of loader plugins. v2 wraps loader configurations into **named input streams**. Each stream is a named group of one or more loaders with its own config. Streams can be conditionally enabled (e.g., only in CI) and merged selectively.

### Why

- A GitHub secrets stream should only merge in CI/CD, not local dev.
- A Firebase feature flags stream has different caching/refresh semantics than filesystem values.
- Remote config sources need versioning and staleness controls.
- Developers want to reason about "which streams are active" rather than "which loaders ran."

### v1 manifest

```yaml
plugins:
  loaders:
    - filesystem-values
    - filesystem-secrets
    - dotenv
    - process-env
    - cli-args
```

### v2 manifest

```yaml
streams:
  local:
    loaders:
      - filesystem-values
      - filesystem-secrets
      - dotenv
    enabled: always

  env:
    loaders:
      - process-env
      - cli-args
    enabled: always

  github:
    loader: github-secrets
    config:
      token: ${GITHUB_TOKEN}
      repo: myorg/config
    enabled:
      when: env.CI == "true"

  firebase:
    loader: firebase-remote-config
    config:
      projectId: my-project
    namespace: flag                # custom namespace: flag.*
    enabled: always
    refresh:
      strategy: lazy              # lazy | eager | manual
      ttl: 300                    # seconds
```

### Impact on existing code

- `plugins.loaders` is replaced by `streams`.
- The flat loader list still works internally — streams are a compositional layer.
- `LoaderContext` gains `streamId: string`.
- `ConfigEntry` gains `streamId: string`.
- `resolution.precedence` now references stream IDs, not loader IDs.

### Merge configuration

```yaml
resolution:
  precedence:
    - local
    - github
    - firebase
    - env                        # process-env + cli-args, highest priority
  merge:
    github:
      environments: [ci, stage, prod]   # only merge in these envs
    firebase:
      environments: [all]
```

---

## 2. Named Output Surfaces

### What changes

v1 has implicit output: `toEnv()`, `toPublicEnv()`, `dump`, in-process reads. v2 formalizes these as **named output surfaces** with explicit namespace filtering and consumer targeting.

### Why

- Browser bundles must never see `secret.*` or non-promoted `value.*`.
- Server runtime sees everything.
- Env export sees only explicitly mapped keys.
- Public export sees only promoted keys.
- Feature flag surface may expose `flag.*` to both server and browser.
- Future: remote sync surface pushes config to hosted CNOS instances.

### v2 manifest

```yaml
surfaces:
  server:
    namespaces: [value, secret, meta, flag]
    runtime: "@kitsy/cnos"

  browser:
    namespaces: [value, flag]
    filter: public.promote         # only promoted value.* keys
    runtime: "@kitsy/cnos/browser"

  env:
    type: env-export
    namespaces: [value, secret]
    filter: envMapping.explicit

  public:
    type: env-export
    namespaces: [value]
    filter: public.promote
    frameworks:
      next: NEXT_PUBLIC_
      vite: VITE_
```

### Impact on existing code

- `toEnv()` and `toPublicEnv()` still work — they are convenience methods backed by the `env` and `public` surfaces.
- New: `cnos.surface("browser")` returns a filtered read-only view.
- Surface definitions make the boundary between server and browser **explicit and auditable**.

---

## 3. Custom Namespaces

### What changes

v1 has three fixed namespaces: `value`, `secret`, `meta`. v2 allows user-defined namespaces declared in the manifest.

### Why

- Feature flags (`flag.*`) are not values or secrets — they have different refresh semantics and may come from Firebase.
- Remote config (`remote.*`) may be versioned and synced differently.
- Teams may define domain-specific namespaces (`experiment.*`, `pricing.*`).

### v2 manifest

```yaml
namespaces:
  builtins: [value, secret, meta]   # always present, not redefinable
  custom:
    flag:
      source: firebase              # stream that populates this namespace
      promotable: true              # can be promoted to public/browser
      sensitive: false
    remote:
      source: github
      promotable: false
      sensitive: false
```

### Impact on existing code

- `NamespaceName` changes from a union literal to `string`, with builtins validated.
- Custom namespace keys: `flag.dark-mode.enabled`, `remote.api.rateLimit`.
- `public.promote` can reference `flag.*` keys if `promotable: true`.
- `secret.*` and any namespace with `sensitive: true` can never be promoted.

---

## 4. Multi-Runtime Support

### What changes

v1 ships one runtime: `@kitsy/cnos` (server/Node). v2 adds explicit runtime modules.

### v2 runtimes

| Import | Environment | What it reads |
|--------|-------------|---------------|
| `@kitsy/cnos` | Server / SSR | Everything: `value.*`, `secret.*`, `meta.*`, custom namespaces |
| `@kitsy/cnos/browser` | Browser | Only promoted `value.*` + promotable custom namespaces (e.g. `flag.*`) |

### Browser runtime behavior

- At build time, the bundler plugin (`@kitsy/cnos-vite`, `@kitsy/cnos-next`) resolves the `browser` surface and embeds the promoted key-value pairs into the bundle as a static JSON blob.
- At runtime, `@kitsy/cnos/browser` reads from that embedded blob.
- Optionally, the browser runtime can also connect to a remote refresh source (e.g., Firebase) for feature flags with lazy/eager refresh semantics.
- `cnos.read("secret.*")` on the browser throws — it is not available.
- `cnos.read("value.api.baseUrl")` works if it was promoted.
- `cnos.read("flag.dark-mode.enabled")` works if the `flag` namespace is promotable and promoted.

### Server runtime behavior

- Unchanged from v1: `createCnos()` resolves the full graph.
- New: `createCnos()` is optional if a default stream is configured. See §5.

### Impact on existing code

- `@kitsy/cnos-vite` and `@kitsy/cnos-next` now read the `browser` surface definition from the manifest instead of hardcoding promotion logic.
- The Vite/Next plugins become thinner: they call `cnos.surface("browser").toObject()` and inject the result.

---

## 5. Default Stream and Singleton Access

### What changes

v1 requires `const cnos = await createCnos()` before any reads. v2 supports a default stream that enables `cnos.read(...)` without explicit bootstrap, when the environment is configured.

### How

The manifest declares a default stream:

```yaml
streams:
  local:
    loaders: [filesystem-values, filesystem-secrets, dotenv]
    enabled: always
    default: true              # this stream auto-initializes
```

At import time, `@kitsy/cnos` lazily resolves the default stream from the local `.cnos/` folder. `createCnos()` still works for explicit configuration.

```ts
// Explicit (still supported, unchanged)
import { createCnos } from "@kitsy/cnos";
const cnos = await createCnos({ workspace: "api" });
cnos.read("value.server.port");

// Singleton (new, works when default stream is configured)
import cnos from "@kitsy/cnos";
await cnos.ready();  // or auto-awaited on first read
cnos.read("value.server.port");
```

### Impact

- `createCnos()` API is unchanged.
- Default export from `@kitsy/cnos` is a lazy singleton.
- `@kitsy/cnos/browser` always uses singleton pattern (no createCnos on browser).

---

## 6. Remote Config Versioning

### What changes

Remote streams (GitHub, Firebase, hosted CNOS) introduce the problem of config drift. v2 adds a versioning model.

### How

Remote streams can declare a version pin:

```yaml
streams:
  github:
    loader: github-secrets
    config:
      repo: myorg/config
      ref: v2.3.1                  # git tag/SHA/branch
    enabled:
      when: env.CI == "true"
```

The `ref` field pins the remote config to a specific version. This ensures that the config used in a build/deploy matches the version the app was tested against.

For Firebase and other non-git remote sources, the `version` field serves the same purpose:

```yaml
streams:
  firebase:
    loader: firebase-remote-config
    config:
      projectId: my-project
      version: "2024-01-15T10:00:00Z"   # snapshot timestamp
```

### Impact

- Remote loader plugins must respect `ref` / `version`.
- `meta.stream.<streamId>.version` is populated for remote streams.
- `cnos doctor` warns if a remote stream has no version pin.

---

## 7. Bundler Plugin Architecture

### What changes

v1 has first-party Vite and Next plugins. v2 formalizes the bundler plugin contract so that Webpack and other bundlers can be supported with the same pattern.

### Contract

Every bundler plugin:
1. Reads the `browser` surface from the manifest.
2. Resolves the promoted key-value pairs at build time.
3. Injects them into the bundle in the format the framework expects.

```ts
interface CnosBundlerPlugin {
  name: string;
  framework: string;
  /**
   * Called at build time. Returns the key-value map to inject.
   */
  resolve(options: BundlerPluginOptions): Promise<Record<string, string>>;
}

interface BundlerPluginOptions {
  cnosRoot?: string;
  workspace?: string;
  profile?: string;
  surface?: string;      // default: "browser"
}
```

### Framework-specific injection

| Framework | Injection target |
|-----------|-----------------|
| Vite | `import.meta.env.VITE_*` |
| Next.js | `process.env.NEXT_PUBLIC_*` |
| Webpack | `process.env.*` via DefinePlugin |
| Generic | `globalThis.__CNOS_PUBLIC__` |

### Impact

- `@kitsy/cnos-vite` and `@kitsy/cnos-next` are refactored to use the bundler plugin contract.
- New: `@kitsy/cnos-webpack` can be built from the same contract.
- The `surfaces.browser.frameworks` config drives the prefix mapping — bundler plugins don't hardcode it.

---

## 8. Impact Summary on Existing Types

### ConfigEntry

```ts
interface ConfigEntry {
  // ... existing fields unchanged ...
  streamId: string;          // NEW: which stream produced this entry
}
```

### NamespaceName

```ts
// v1: type NamespaceName = "value" | "secret" | "meta";
// v2: string, with builtins validated at manifest load
type NamespaceName = string;
const BUILTIN_NAMESPACES = ["value", "secret", "meta"] as const;
```

### LoaderContext

```ts
interface LoaderContext {
  // ... existing fields unchanged ...
  streamId: string;          // NEW
  streamConfig: Record<string, unknown>;  // NEW: stream-specific config
}
```

### ResolvedGraph

```ts
interface ResolvedGraph {
  // ... existing fields unchanged ...
  activeStreams: string[];   // NEW: which streams contributed
}
```

### CnosRuntime

```ts
interface CnosRuntime {
  // ... existing methods unchanged ...
  surface(name: string): SurfaceView;  // NEW
}

interface SurfaceView {
  read<T = unknown>(key: LogicalKey): T | undefined;
  require<T = unknown>(key: LogicalKey): T;
  toObject(): Record<string, unknown>;
  toEnv(): Record<string, string>;
}
```

### New meta keys

| Key | Value |
|-----|-------|
| `meta.streams.active` | JSON array of active stream IDs |
| `meta.stream.<id>.version` | Version/ref for remote streams |
| `meta.stream.<id>.refreshedAt` | Last refresh timestamp for remote streams |

---

## 9. What Does NOT Change

- Workspace model (§6 of v1 spec) — unchanged.
- Profile model — unchanged.
- Write policy — unchanged.
- `cnos dump` / `cnos run` / `cnos diff` — unchanged.
- Secret vault model — unchanged.
- `.cnos/cnos.yml` as authoritative local manifest — unchanged.
- `.cnos-workspace.yml` — unchanged.
- Local-first authority — unchanged.
- Hard constraints around `secret.*` and public promotion — unchanged (extended to custom sensitive namespaces).

---

## 10. v2 Scope

### In v2

- Named input streams (manifest-declared, conditionally enabled).
- Named output surfaces (server, browser, env, public).
- Custom namespace definitions.
- Browser runtime module (`@kitsy/cnos/browser`).
- Singleton/default stream access pattern.
- Bundler plugin contract formalization.
- Stream-level merge configuration.
- Remote stream version pinning.
- `meta.streams.*` keys.

### Deferred beyond v2

- Actual remote loader implementations (GitHub, Firebase) — v2 defines the contracts and manifest shape; implementations can be community or first-party plugins.
- Hosted CNOS server/sync.
- Cross-stream conflict detection/warnings.
- Live reload/watch on remote streams.
- OS keychain secret provider integration.
