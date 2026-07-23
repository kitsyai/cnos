# CNOS

CNOS is a plugin-first configuration orchestration system. This repository is a pnpm monorepo for the CNOS core runtime, the batteries-included runtime package, the CLI, official plugins, and example applications.

## Package map

- `@kitsy/cnos`: batteries-included runtime assembly. It bundles the core engine plus the official built-in plugins and re-exports those built-ins under `@kitsy/cnos/plugins/*`.
- `@kitsy/cnos-cli`: `cnos` executable and command routing. It depends only on `@kitsy/cnos`.
- `@kitsy/cnos-vite`: first-party Vite integration for CNOS public env injection.
- `@kitsy/cnos-next`: first-party Next.js integration for CNOS public env injection.
- `@kitsy/cnos-webpack`: first-party webpack integration for CNOS public env injection.
- `@kitsy/cnos-docs`: source-of-truth MDX documentation package for Astro Starlight and other static docs consumers.
- `packages/go`: first-party Go runtime client for CNOS runtime graph and server projection bootstraps, native `.cnos/` and Git-backed remote resolution, live derived reads, inspect/provenance, singleton helpers, and vault-backed secret hydration outside Node.js.

Internal workspaces such as `packages/core` and `plugins/*` remain in the source monorepo for development, but they are not published as standalone npm packages.

## Workspace commands

- `pnpm install`
- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm check`
- `pnpm publish:check`

## Local development

The workspace uses pnpm workspaces, TypeScript, tsup, Vitest, ESLint, Prettier, Changesets, and a standalone Go runtime module under `packages/go`. Core packages live under `packages/*`, official plugins live under `plugins/*`, examples live under `examples/*`, and long-form specifications stay in `docs/`.

The current v1 CLI is workspace-aware and includes `init`, `onboard`, `use`, `profile`, `list`, `read`, `value`, `secret`, `inspect`, `define`, `validate`, `export env`, `dump`, `run`, `diff`, `doctor`, `help`, and `help-ai`.

Recent DX behavior:
- `cnos use show` reads the current repo-local CLI context and does not create `.cnos-workspace.yml` unless you persist values.
- `cnos list value` and `cnos list secret` show stored CNOS config, not ambient shell env winners.
- `cnos list env` shows only explicitly mapped env exports.
- `cnos vault create <name>` creates a manifest-defined vault and, for local vaults, initializes encrypted secret storage under `~/.cnos/secrets`.
- command failures are concise by default; pass `--verbose` for stack traces.

Framework integrations currently ship as `@kitsy/cnos-vite`, `@kitsy/cnos-next`, and `@kitsy/cnos-webpack`. Official built-ins remain available from `@kitsy/cnos/plugins/*`.

For step-by-step setup flows, see [docs/cnos-how-to.md](/Users/pkvsi/Wks/kitsy/cnos/docs/cnos-how-to.md).

## Release flow

CNOS supports two release modes:

- A global release bumps every runtime and pushes `vX.Y.Z`, which triggers every publish workflow.
- A partial release bumps one ecosystem and pushes `release/<ecosystem>/vX.Y.Z`, which triggers only that ecosystem's workflow.

Use a partial release when a feature or fix exists in only some runtime implementations:

```powershell
.\scripts\release-part.ps1 node minor
.\scripts\release-part.ps1 go 1.18.0
```

```bash
bash ./scripts/release-part.sh node minor
bash ./scripts/release-part.sh go 1.18.0
```

Node, Go, Java, Kotlin, Python, Rust, C#, and PHP maintain independent registry version sequences under this flow. Node and Go can both publish `1.18.0` from separate scoped tags without creating a global `v1.18.0` tag.

Do not push a global `vX.Y.Z` tag after any ecosystem has already published that version through a scoped tag. Global tags intentionally trigger all registries and would attempt duplicate publication. Release tags are immutable; retry a failed GitHub Actions run from the existing tag rather than deleting, moving, or recreating it.

`@kitsy/cnos-core` is private and never published directly. Public Node packages bundle the core implementation and declarations they expose.

See the [release guide](packages/docs/docs/guides/releases.mdx) for prerequisites, supported commands, tag behavior, and Go module details.
