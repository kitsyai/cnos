# CNOS

CNOS is a plugin-first configuration orchestration system. This repository is a pnpm monorepo for the CNOS core runtime, the batteries-included runtime package, the CLI, official plugins, and example applications.

## Package map

- `@kitsy/cnos-core`: workflow orchestrator, contracts, manifest model, and runtime primitives.
- `@kitsy/cnos`: batteries-included runtime assembly with the official v1 plugins and convenience re-exports under `@kitsy/cnos/plugin/*`.
- `@kitsy/cnos-cli`: `cnos` executable and command routing.
- `@kitsy/cnos-plugin-*`: official plugins kept as separate publishable packages.

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

The current v1 CLI is workspace-aware and includes `init`, `read`, `value`, `secret`, `inspect`, `define`, `validate`, `export env`, `dump`, `run`, `diff`, and `doctor`.

## Release flow

Versioning and publishing are managed through Changesets.

1. Add a changeset with `pnpm changeset`.
2. Prepare versions with `pnpm version-packages`.
3. Publish from CI with the release workflow or locally with `pnpm release`.
