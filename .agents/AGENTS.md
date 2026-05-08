# CNOS — Agent Instructions

## What CNOS Is

CNOS is a configuration resolution system for applications and monorepos. It sits between configuration sources and application surfaces.

```
Named Input Streams → CNOS core (workspace, namespace, resolve, validate) → Projections / Exports / Read APIs
```

Application code reads logical keys like `value.server.port` or `secret.db.password`. CNOS decides where values come from, how they're resolved, and what each consumer (server, browser, CLI, CI/CD) is allowed to see.

CNOS is NOT a dotenv wrapper. It is a portable, plugin-based configuration resolution system with workspace isolation, profile inheritance, secret vault integration, derived value evaluation, and multi-surface projection.

## Packages

| Package | Published as | What it does |
|---------|-------------|-------------|
| `packages/cnos/` | `@kitsy/cnos` | Core engine, server runtime (`@kitsy/cnos`), browser runtime (`@kitsy/cnos/browser`), build utility (`@kitsy/cnos/build`) |
| `packages/cli/` | `@kitsy/cnos-cli` | CLI commands: init, read, define, inspect, validate, export, run, dump, diff, doctor, promote, vault, codegen, watch, migrate, drift, onboard, workspace, build |
| `packages/vite/` | `@kitsy/cnos-vite` | Vite bundler plugin — injects promoted public config at build time |
| `packages/next/` | `@kitsy/cnos-next` | Next.js bundler plugin — same pattern, NEXT_PUBLIC_ prefix |

## Monorepo Tooling

- Package manager: pnpm (workspace)
- Test: vitest
- TypeScript: strict mode

## Key Concepts (Quick Reference)

**Namespaces.** Config namespaces: `value.*` (non-secret config), `secret.*` (sensitive, vault-backed), `meta.*` (system-populated, read-only). User-defined custom namespaces declared in manifest. Runtime namespaces: `process.*` (built-in), plus user-defined like `request.*`, `session.*`.

**Workspaces.** Named config subtrees for monorepo isolation. One active workspace per invocation. `base` is the conventional shared workspace. Regular (flat) repos are treated as implicit `base`.

**Profiles.** Environment layers: `local`, `stage`, `prod`. Profile inheritance (`stage extends base`). Orthogonal to workspaces.

**Projection.** Flat payload of resolved config for a specific consumer. Server projection (values + secret refs), browser projection (promoted values only), env projection (flat KEY=VALUE).

**Derived values.** Config computed from other config via a safe expression language. Template shorthand: `$derive: "${value.app.protocol}://${value.app.host}"`. Expression syntax for conditionals: `$derive: { expr: "coalesce(process.env.PORT, value.app.default_port, '3000')" }`.

**Secret vaults.** Repo YAML stores only refs (`{ provider, vault, ref }`). Actual secret material lives outside the repo in encrypted vaults (`~/.cnos/secrets/vaults/`) or remote providers. Secrets are batch-resolved at startup, cached in memory, never persisted. AES-256-GCM encryption, PBKDF2-SHA512 key derivation.

**Anchor-based discovery.** Every package that uses CNOS has a `.cnosrc.yml` that declares where its config root is. No unbounded upward filesystem walk. Discovery is explicit and deterministic.

## Critical Rules for All Agents

1. **Do NOT modify application code to make a failing test pass.** Report the failure for triage. This is non-negotiable.
2. **Do NOT add dependencies** without approval.
3. **Do NOT change public API signatures** without checking `.agents/ARCHITECTURE.md`.
4. **Secrets must never appear in plaintext** in any committed file, log output, CLI output (without `--reveal`), build artifact, or `__CNOS_PROJECTION__` env var.
5. **`secret.*` and `sensitive: true` namespaces must never reach public/browser surfaces.** Enforced at namespace level, projection level, and promotion level.
6. **Run `pnpm test` before considering any change complete.**
7. **Passphrases are never accepted as CLI arguments** in strict mode. Use env vars, OS keychain, or interactive prompt.
8. **Browser projections always contain concrete values**, never formulas or secret refs.
9. **Runtime-dependent derived values (those referencing runtime namespaces like `process.*`, `request.*`) are never cached.** Config-only derived values are cached once per resolution pass.

## Where to Find More Detail

| Need | Read |
|------|------|
| Module layout, types, pipeline stages, CLI surface | `.agents/ARCHITECTURE.md` |
| Code style, naming, commits, testing patterns | `.agents/CONVENTIONS.md` |
| Secret security model, vault providers, encryption, auth | `.agents/context/security-design.md` |
| Derived values, expression language, caching rules | `.agents/context/derived-values.md` |
| Monorepo projection, anchor discovery, server/browser delivery | `.agents/context/monorepo-projection.md` |
| Remote root resolution (git, future hosted) | `.agents/context/remote-root-resolver.md` |
| DX refresh: implicit base, workspace enable, onboard | `.agents/context/dx-refresh.md` |
| Role-specific instructions | `.agents/skills/<role>/SKILL.md` |

## Task Routing

Based on what you've been asked to do:

- **Implementing a feature** → Read `ARCHITECTURE.md` then `.agents/skills/developer/SKILL.md`
- **Writing or fixing tests** → Read `.agents/skills/tester/SKILL.md`
- **Designing or evaluating architecture** → Read `.agents/skills/architect/SKILL.md`
- **Reviewing code** → Read `.agents/skills/reviewer/SKILL.md`
- **Writing documentation** → Read `.agents/skills/docs-writer/SKILL.md`
