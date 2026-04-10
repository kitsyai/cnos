# CNOS

CNOS is a plugin-first configuration orchestration system. This repository is a pnpm monorepo for the CNOS core runtime, the batteries-included runtime package, the CLI, official plugins, and example applications.

## Package map

- `@kitsy/cnos`: batteries-included runtime assembly. It bundles the core engine plus the official built-in plugins and re-exports those built-ins under `@kitsy/cnos/plugins/*`.
- `@kitsy/cnos-cli`: `cnos` executable and command routing. It depends only on `@kitsy/cnos`.
- `@kitsy/cnos-vite`: first-party Vite integration for CNOS public env injection.
- `@kitsy/cnos-next`: first-party Next.js integration for CNOS public env injection.
- `@kitsy/cnos-webpack`: first-party webpack integration for CNOS public env injection.
- `@kitsy/cnos-docs`: source-of-truth MDX documentation package for Astro Starlight and other static docs consumers.

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

The workspace uses pnpm workspaces, TypeScript, tsup, Vitest, ESLint, Prettier, and Changesets. Core packages live under `packages/*`, official plugins live under `plugins/*`, examples live under `examples/*`, and long-form specifications stay in `docs/`.

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

Versioning and publishing are managed through Changesets.

1. Add a changeset with `pnpm changeset`.
2. Prepare versions with `pnpm version-packages`.
3. Publish from CI with the release workflow or locally with `pnpm release`.

For manual `pnpm publish`, the public packages now rebuild on `prepack` so `dist/` cannot drift from `package.json` version bumps.
