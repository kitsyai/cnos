# Developer Skill

You are implementing features in the CNOS codebase.

## Before Writing Code

1. Read `.agents/AGENTS.md` for repo overview and source-of-truth rules.
2. Read `.agents/ARCHITECTURE.md` for package boundaries and module placement.
3. Read `.agents/CONVENTIONS.md` for code style and testing rules.
4. Read the relevant `.agents/context/*.md` file for the feature area.
5. Check the test suite spec and existing tests for expected behavior and test IDs.

## Placement Rules

Choose the right package before you edit.

- Core engine behavior: `packages/core/src/`
- Batteries-included runtime wrappers: `packages/cnos/src/`
- Official built-in plugin implementations: `plugins/<plugin-name>/src/`
- Plugin re-exports and default wiring: `packages/cnos/src/plugin/`, `packages/cnos/src/defaultPlugins.ts`
- CLI commands/help/services: `packages/cli/src/`
- Published docs: `packages/docs/`

## Implementation Rules

- Write types first, then implementation, then tests.
- Export public APIs from the package entrypoints. Do not expose internals casually.
- Add JSDoc to public functions and public types.
- If CLI behavior changes, update `packages/cli/src/cli/helpRegistry.ts`.
- If published docs need to change, update `packages/docs/docs/` and `packages/docs/manifest.yml`.
- Run `pnpm test` after the change.
- If a test appears wrong, do not patch around it. Report the failure and the reason.

## Common Implementation Patterns

### Adding a CLI command

1. Create or update `packages/cli/src/commands/<name>.ts`.
2. Register routing and help in `packages/cli/src/cli/helpRegistry.ts`.
3. Add or update command tests in `packages/cli/test/`.
4. Add a docs page in `packages/docs/docs/cli/<name>.mdx`.
5. Add the page to `packages/docs/manifest.yml`.

`helpRegistry.ts` and `cnos help-ai --format json` are the canonical CLI contracts. Do not hand-invent flags in docs or tests.

### Adding or changing official built-in plugins

1. Implement the plugin in `plugins/<plugin-name>/src/`.
2. Export it from that plugin package's public entrypoint.
3. Re-export it from `packages/cnos/src/plugin/` if the batteries-included package should expose it.
4. Wire it into `packages/cnos/src/defaultPlugins.ts` if it belongs in the default runtime.
5. Add tests.

### Modifying manifest schema

1. Update `packages/core/src/types/manifest.ts`.
2. Update `packages/core/src/manifest/normalizeManifest.ts`.
3. Ensure omitted fields still normalize safely for backward compatibility.
4. Update any affected validation/resolution code in `packages/core/src/`.
5. Update `.agents/context/manifest.md` if the conceptual model changed.
6. Update published docs in `packages/docs/docs/reference/manifest.mdx`.

### Working with runtime APIs

- Core runtime contract: `packages/core/src/types/core.ts`
- Singleton wrapper extras: `packages/cnos/src/runtime/index.ts`

Do not mix them up in code or docs. `ready()`, `format()`, `log()`, and `loadProjection()` are singleton wrapper helpers, not core runtime methods.

### Working with projections

- Server projection: values + derived formulas + secret refs, never plaintext secrets
- Browser/public output: promoted concrete values only
- `cnos run` bootstraps both `__CNOS_GRAPH__` and `__CNOS_PROJECTION__`
- Config-only derived values resolve to concrete values in projection output
- Runtime-dependent derived values stay live and must not be forced into browser/public output
