# CNOS

CNOS is a plugin-first configuration orchestration system. This repository is a pnpm monorepo for the CNOS core runtime, the batteries-included runtime package, the CLI, official plugins, and example applications.

## Package map

- `@kitsy/cnos`: batteries-included runtime assembly. It bundles the core engine plus the official built-in plugins and re-exports those built-ins under `@kitsy/cnos/plugins/*`.
- `@kitsy/cnos-cli`: `cnos` executable and command routing. It depends only on `@kitsy/cnos`.
- `@kitsy/cnos-vite`: first-party Vite integration for CNOS public env injection.
- `@kitsy/cnos-next`: first-party Next.js integration for CNOS public env injection.

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

Framework integrations currently ship as `@kitsy/cnos-vite` and `@kitsy/cnos-next`. Official built-ins remain available from `@kitsy/cnos/plugins/*`.

## Release flow

Versioning and publishing are managed through Changesets.

1. Add a changeset with `pnpm changeset`.
2. Prepare versions with `pnpm version-packages`.
3. Publish from CI with the release workflow or locally with `pnpm release`.
