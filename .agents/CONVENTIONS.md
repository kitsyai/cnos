# CNOS — Conventions

## Code Style

- TypeScript strict mode. No `any` unless absolutely necessary and commented why.
- Small, focused modules. One concern per file. Files should not exceed ~300 lines; split if growing.
- Explicit interfaces for all public APIs. No inferred return types on exported functions.
- Explicit error messages: state what happened, which key/file/vault is involved, and what the user should do.
- Comments for non-obvious behavior only. Do not comment obvious code.
- No premature abstraction. Build the concrete thing first, generalize only when a second use case appears.
- Prefer Node.js built-ins (`node:crypto`, `node:fs`, `node:path`, `node:child_process`) over npm packages.

## Naming

- **Files:** camelCase — `resolveWorkspace.ts`, `filesystemValues.ts`, `toServerProjection.ts`.
- **Types/Interfaces:** PascalCase — `ConfigEntry`, `ResolvedGraph`, `WorkspaceContext`, `SecretRef`.
- **Functions:** camelCase — `createCnos`, `toServerProjection`, `evaluateDerived`.
- **Constants:** UPPER_SNAKE for true constants (`BUILTIN_NAMESPACES`, `MAX_DISCOVERY_DEPTH`), camelCase for config-like values.
- **Error classes:** `Cnos` prefix + PascalCase — `CnosSecurityError`, `CnosAuthenticationError`.
- **Test files:** `<module>.test.ts` alongside the source file.
- **CLI commands:** kebab-case in user-facing names, camelCase in file names — command `workspace enable` → file `workspaceEnable.ts`.

## Commits

Format: `<type>(<scope>): <description>`

- **Types:** `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
- **Scope:** package or module — `cnos`, `cli`, `vite`, `next`, `derive`, `secrets`, `projection`, `discovery`
- **Examples:**
  - `feat(derive): add template shorthand parser`
  - `fix(secrets): handle missing vault gracefully in batch resolve`
  - `test(projection): add server projection edge cases`
  - `refactor(discovery): extract git URI parser into separate module`
  - `docs(cli): add onboard command reference`

## Testing

- **Framework:** vitest
- **Run all:** `pnpm test`
- **Run specific:** `pnpm test src/derive/evaluator.test.ts`
- **Coverage:** `pnpm test --coverage`

### Test naming

Use test IDs from the test suite spec when they exist:

```ts
describe("evaluator", () => {
  it("DRV-V-1: simple derived value resolves at read time", () => { ... });
  it("DRV-V-4: cycle detection throws CnosDerivedCycleError with chain", () => { ... });
});
```

For tests without spec IDs, use descriptive names:

```ts
it("should return undefined for missing key", () => { ... });
it("should throw CnosSecurityError when secret.* is in public.promote", () => { ... });
```

### Test rules

- Every public API method must have at least one test.
- Security invariants (SEC-* tests) must verify the **negative case**: the bad thing does NOT happen.
- Edge cases must cover: empty strings, null, undefined, unicode, very long values, type preservation (number stays number, boolean stays boolean).
- Integration tests verify full end-to-end flows.
- **Never modify application code to make a test pass.** Report the failure for triage.

### Test location

- Unit tests: alongside source — `evaluator.ts` → `evaluator.test.ts`
- Integration tests: `__tests__/integration/`
- Golden/snapshot tests: `__tests__/golden/`

## Error Handling

- Use typed error classes. All CNOS errors extend a base `CnosError` class.
- Error messages must include:
  - **What** happened: "Secret key found in public.promote"
  - **Which** resource: "secret.db.password"
  - **What to do**: "Remove secret.db.password from public.promote in .cnos/cnos.yml"
- Never swallow errors silently. Log or throw.
- Never print stack traces by default. Use `--verbose` flag for stack traces.
- Use `process.exitCode = 1` in CLI, not `process.exit(1)` (allows cleanup).

## Security

These rules are non-negotiable. Violating any of them is a critical bug.

- `secret.*` and any namespace with `sensitive: true` must NEVER appear in:
  - `toPublicEnv()` output
  - browser runtime data (`__CNOS_BROWSER_DATA__`)
  - `cnos build browser` or `cnos build public` output
  - CLI output without `--reveal` flag
- No plaintext secrets in committed files. Repo YAML stores only `{ provider, vault, ref }` objects.
- No plaintext passphrases in manifest, `.cnosrc.yml`, or `.cnos-workspace.yml`.
- CLI output masks secrets with `****` by default. `--reveal` flag required for actual values.
- TTY stdout: masked. Piped (non-TTY): real values. File output (`--to`): real values.
- `__CNOS_PROJECTION__` env var contains secret refs, never decrypted values.
- `cnos run --auth` encrypts secrets with a session key before passing to child process.
- Passphrases never accepted as CLI args in strict mode (`CNOS_STRICT_AUTH=true` or `NODE_ENV=production`).
- All vault operations logged to audit trail (`~/.cnos/audit/access.log`). Values never logged.
- Derived expressions cannot reference `secret.*` namespace.

## Manifest Conventions

- Optional sections use sensible defaults when absent. A minimal manifest needs only `version` and `project.name`.
- `profiles.default` is always `local` in scaffolds. Never `base` (that's a workspace name).
- `base` is the conventional shared workspace name. Not hardcoded in the resolver — just convention.
- Source paths in manifest are relative to the workspace root, not the manifest root.
- The manifest is the single source of truth for structural config: plugins, precedence, schema, promotions, write policy.

## CLI Conventions

- All commands that operate on config accept `--workspace` and `--profile` flags.
- `--json` flag produces machine-readable JSON output for any command.
- `--reveal` flag shows secret values (otherwise masked).
- `--verbose` flag shows detailed error output with stack traces.
- Non-interactive shell detection: `process.stdout.isTTY`. When false, skip prompts (use safe defaults), include real values in piped output.
- Confirmation messages and warnings go to stderr, not stdout (keeps piped output clean).

## Dependencies

- Do not add new dependencies without approval.
- Approved external deps: YAML parser, CLI framework (whatever is already in use).
- Everything else: prefer Node.js built-ins. `node:crypto` for encryption, `node:fs` for file I/O, `node:child_process` for subprocess spawning.
