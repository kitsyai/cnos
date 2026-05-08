# Developer Skill

You are implementing features in the CNOS codebase.

## Before Writing Code

1. Read `.agents/AGENTS.md` for project overview.
2. Read `.agents/ARCHITECTURE.md` for module layout and types.
3. Read `.agents/CONVENTIONS.md` for code style.
4. Check `.agents/context/` for the spec that covers your feature.
5. Check the test suite spec for expected behavior and test IDs.

## Implementation Rules

- Write types first, then implementation, then tests.
- Follow the module layout in `ARCHITECTURE.md`. New code goes in the right module:
  - New loader → `packages/cnos/src/loaders/`
  - New validator → `packages/cnos/src/validators/`
  - New CLI command → `packages/cli/src/commands/`
  - Derived value changes → `packages/cnos/src/derive/`
  - Secret/vault changes → `packages/cnos/src/secrets/`
  - Projection changes → `packages/cnos/src/projection/`
  - Discovery changes → `packages/cnos/src/discovery/`
- Export public APIs from the package's `index.ts`. Do not expose internal modules.
- Add JSDoc to all public functions and types.
- Run `pnpm test` after every change.
- If a test fails and you believe the test is wrong, do NOT fix the test. Report it for triage with your reasoning.

## Common Implementation Patterns

### Adding a CLI command

1. Create `packages/cli/src/commands/<name>.ts`.
2. Export a function that handles args and calls into `@kitsy/cnos` core.
3. Register in the command router.
4. Add help text (shown by `cnos help <name>`).
5. Add a docs page in `packages/cnos-docs/docs/cli/<name>.mdx`.
6. Add tests.

### Adding a loader plugin

1. Implement `LoaderPlugin` interface in `packages/cnos/src/loaders/<name>.ts`.
2. The `load()` method receives `LoaderContext` and returns `ConfigEntry[]`.
3. Every entry must include: `key`, `value`, `namespace`, `sourceId`, `pluginId`, `streamId`, `workspaceId`.
4. Include `origin` with at least `file` path for filesystem loaders.
5. Register in the default plugin set.
6. Add tests.

### Adding a vault provider

1. Implement `SecretVaultProvider` interface in `packages/cnos/src/secrets/providers/<name>.ts`.
2. Must implement `batchGet()` for efficient startup hydration.
3. `authenticate()` must throw `CnosAuthenticationError` on failure — never return false silently.
4. Register in the provider registry.
5. Add tests for: auth success, auth failure, batch get, single get, missing secret.

### Adding a derived value built-in function

1. Add the function to `packages/cnos/src/derive/builtins.ts`.
2. Register the function name in the parser's known-function list.
3. The function must be pure: no side effects, no I/O, deterministic for same inputs.
4. Add parser tests (syntax), evaluator tests (behavior), and edge case tests.

### Modifying the manifest schema

1. Update types in `packages/cnos/src/types/manifest.ts`.
2. Update normalization in `packages/cnos/src/manifest/normalizeManifest.ts` — add defaults for the new field.
3. Ensure existing manifests without the new field continue to work (backward compat via defaults).
4. Update `ARCHITECTURE.md` manifest example.
5. Update docs: `packages/cnos-docs/docs/reference/manifest.mdx`.

### Working with projections

- Server projection (`toServerProjection()`): values + secret refs + derived formulas. No plaintext secrets.
- Browser projection (`resolveBrowserData()`): promoted `value.*` only. Concrete values, never formulas.
- Config-only derived values → resolved to concrete in projection `values`.
- Runtime-dependent derived values → kept as formulas in projection `derived`.
- Always verify: no `secret.*` in browser data, no plaintext in server projection.
