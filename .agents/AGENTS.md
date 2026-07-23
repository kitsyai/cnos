# CNOS - Agent Instructions

## What CNOS Is

CNOS is a configuration resolution system for applications and monorepos. It sits between configuration sources and application surfaces.

```text
Named input streams -> CNOS core (workspace, profile, resolve, validate) -> projections / exports / read APIs
```

Application code reads logical keys like `value.server.port` or `secret.db.password`. CNOS decides where values come from, how they are resolved, and what each consumer is allowed to see.

CNOS is not a dotenv wrapper. It is a portable, plugin-based configuration system with workspace isolation, profile inheritance, secret vault integration, derived value evaluation, and multi-surface projection.

## Packages

| Package | Published as | What it does |
|---------|--------------|--------------|
| `packages/core/` | Private workspace package | Core contracts, manifest/profile/workspace resolution, derivation, validation, projection, secret handling; bundled into public Node packages, never published directly |
| `packages/cnos/` | `@kitsy/cnos` | Batteries-included runtime package, singleton runtime, browser runtime, build helpers, plugin re-exports |
| `packages/cli/` | `@kitsy/cnos-cli` | CLI commands, help surfaces, formatting, repo workflows |
| `packages/docs/` | `@kitsy/cnos-docs` | Published docs content for the web docs site and other docs consumers |
| `packages/vite/` | `@kitsy/cnos-vite` | Vite integration for promoted public config |
| `packages/next/` | `@kitsy/cnos-next` | Next.js integration for promoted public config |
| `packages/webpack/` | `@kitsy/cnos-webpack` | Webpack integration for promoted public config |
| `packages/var-server/` | `@kitsy/cnos-var-server` | Embeddable `var.*` control-plane library: revisions, activation, rollback, audit log, pluggable storage; also backs `cnos var serve` |
| `packages/var-http/` | `@kitsy/cnos-var-http` | http transport provider for `var.*` sources |
| `packages/var-testkit/` | `@kitsy/cnos-var-testkit` | Test doubles for `var.*` (ephemeral server, in-memory source), mirrors `vault-testkit` |
| `plugins/*` | `@kitsy/cnos-plugin-*` | Official loader / validator / exporter plugin packages |

## Monorepo Tooling

- Package manager: pnpm
- Test runner: vitest
- TypeScript: strict mode

## Key Concepts

**Namespaces.** Config namespaces: `value.*` (non-secret config), `secret.*` (sensitive, vault-backed), `meta.*` (system-populated, read-only), `public.*` (promotion output), and user-defined custom namespaces declared in the manifest. Runtime namespaces include built-in `process.*` plus custom namespaces such as `request.*` and `session.*`.

**Workspaces.** Named config subtrees for monorepo isolation. One active workspace per invocation. `base` is the conventional shared workspace. Flat repos are treated as implicit `base`.

**Profiles.** Environment overlays such as `local`, `stage`, and `prod`. Profiles are orthogonal to workspaces.

**Projection.** A resolved payload for a specific consumer. Server projection includes values, derived formulas, and secret refs. Browser projection includes promoted concrete values only. Env export produces flat `KEY=VALUE` output.

**Derived values.** Config computed from other keys via a constrained expression language. Template shorthand covers string composition. Expression syntax covers conditionals and fallbacks.

**Secret vaults.** Repo files store refs only. Secret material lives outside the repo in encrypted local vaults or remote providers. Secrets are hydrated into memory, never committed, and never serialized as plaintext.

**Anchor-based discovery.** Every package that uses CNOS has a `.cnosrc.yml` that declares the config root and workspace. Discovery is explicit and bounded.

## Critical Rules For All Agents

1. Do not modify application code to make a failing test pass. Report the failure for triage.
2. Do not add dependencies without approval.
3. Do not change public API signatures without checking `.agents/ARCHITECTURE.md`.
4. Secrets must never appear in plaintext in committed files, logs, CLI output without `--reveal`, build artifacts, `__CNOS_GRAPH__`, or `__CNOS_PROJECTION__`.
5. `secret.*` and namespaces marked `sensitive: true` must never reach public or browser surfaces.
6. Run `pnpm test` before considering a change complete.
7. Passphrases are never accepted as CLI arguments in strict mode. Use env vars, keychain, or interactive prompt.
8. Browser projections always contain concrete values, never formulas or secret refs.
9. Runtime-dependent derived values are never cached. Config-only derived values are cached once per resolution pass.

## Source Of Truth

Use the right source for the right question:

- `.agents/*`: agent operating guide for working in this repo
- `docs/*`: planning notes, design drafts, and detailed product/spec material
- `packages/docs/*`: published docs content exposed by `@kitsy/cnos-docs`
- `packages/cli/src/cli/helpRegistry.ts`: canonical checked-in CLI surface
- `cnos help-ai --format json`: canonical machine-readable CLI surface at runtime
- `packages/core/src/types/*.ts`: canonical contracts for manifest, runtime, plugin, workspace, and profile types

When `.agents` and another source disagree, prefer the code plus the canonical generated/help surfaces above, then update `.agents`.

## Where To Find More Detail

| Need | Read |
|------|------|
| Package boundaries, runtime surfaces, module layout | `.agents/ARCHITECTURE.md` |
| Code style, naming, testing patterns | `.agents/CONVENTIONS.md` |
| Manifest sections and structural rules | `.agents/context/manifest.md` |
| Namespace rules and safety boundaries | `.agents/context/namespaces.md` |
| Profiles, inheritance, activation | `.agents/context/profiles.md` |
| Resolution order, precedence, inspection flow | `.agents/context/resolution.md` |
| Secret security model, vault providers, auth, masking | `.agents/context/security-design.md` |
| Derived values, expression language, caching | `.agents/context/derived-values.md` |
| Monorepo projection, anchors, detach/attach, runtime delivery | `.agents/context/monorepo-projection.md` |
| Remote root resolution and cache model | `.agents/context/remote-root-resolver.md` |
| DX refresh: implicit base, workspace enable, onboard | `.agents/context/dx-refresh.md` |
| Runtime variables (`var.*`): overlay, control plane, module map, wire conventions | `.agents/context/runtime-vars.md` |
| Role-specific instructions | `.agents/skills/<role>/SKILL.md` |

## Task Routing

Based on what you've been asked to do:

- Implementing a feature: read `.agents/ARCHITECTURE.md` then `.agents/skills/developer/SKILL.md`
- Writing or fixing tests: read `.agents/skills/tester/SKILL.md`
- Designing or evaluating architecture: read `.agents/skills/architect/SKILL.md`
- Reviewing code: read `.agents/skills/reviewer/SKILL.md`
- Writing documentation: read `.agents/skills/docs-writer/SKILL.md`
