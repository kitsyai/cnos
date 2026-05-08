# Docs Writer Skill

You are writing documentation for `@kitsy/cnos-docs`.

## Where Docs Live

Content: `packages/cnos-docs/docs/`
Navigation: `packages/cnos-docs/manifest.yml`
Images: `packages/cnos-docs/assets/images/`

The docs are rendered by Astro + Starlight in `apps/cnos-docs-site/` and served at `cnos.kitsy.ai/docs/`.

## Doc Structure

```
docs/
  index.mdx                         # docs landing
  getting-started/
    installation.mdx
    quick-start.mdx
    your-first-project.mdx
  guides/
    backend.mdx
    frontend-vite.mdx
    frontend-next.mdx
    ssr.mdx
    ci-cd.mdx
    workspaces.mdx
    profiles.mdx
    secrets.mdx
    migration.mdx
    derived-values.mdx
  cli/
    init.mdx, read.mdx, value.mdx, secret.mdx, define.mdx,
    inspect.mdx, validate.mdx, export.mdx, run.mdx, diff.mdx,
    dump.mdx, doctor.mdx, promote.mdx, vault.mdx, codegen.mdx,
    watch.mdx, migrate.mdx, drift.mdx, onboard.mdx, workspace.mdx,
    build.mdx, cache.mdx
  api/
    create-cnos.mdx, runtime.mdx, singleton.mdx, browser.mdx, types.mdx
  reference/
    manifest.mdx, namespaces.mdx, resolution.mdx, security.mdx
  concepts/
    how-it-works.mdx, config-spectrum.mdx
```

## Frontmatter

Every `.mdx` file must start with:

```yaml
---
title: Installation
description: Install CNOS and get started in under 5 minutes.
---
```

Required: `title`, `description`. Optional: `sidebar_label`, `sidebar_position`, `draft`.

## Writing Rules

- Every code example must be copy-pasteable and working. No pseudocode.
- CLI examples use `bash` code fence language.
- One topic per file.
- Internal links use relative paths: `[installation](./installation.mdx)`.
- Admonitions: `:::note`, `:::tip`, `:::caution`, `:::danger`.
- Keep language direct and concise. No filler words.
- Show the simplest example first, then the advanced version.

## Consistent Examples

All examples must show:
- `profiles.default: local` (never `base` as a profile name)
- `base` as workspace root when showing workspace mode
- Child workspaces `extends: [base]`
- `cnos run` as the hero command for getting started
- `cnos.value("server.port")` for runtime code examples

## CLI Command Pages

Each CLI command page should have:

1. **Usage line:** `cnos <command> [options]`
2. **Description:** one paragraph explaining what it does.
3. **Flags table:** flag, type, default, description.
4. **Examples:** at least 2 — one simple, one with flags.
5. **Related commands:** links to related CLI pages.

Example structure:

```mdx
---
title: cnos run
description: Inject resolved config into a child process as environment variables.
---

# cnos run

Resolves the config graph and spawns a child process with the resolved values
injected as environment variables. The child reads `process.env` as usual — no
CNOS-specific code required.

## Usage

\`\`\`bash
cnos run [--profile <name>] [--workspace <id>] [--auth] [--set <key>=<value>] -- <command>
\`\`\`

## Flags

| Flag | Description |
|------|-------------|
| `--profile` | Override active profile |
| `--workspace` | Override active workspace |
| `--auth` | Pre-authenticate vaults, pass secrets to child securely |
| `--set` | Inline value override (repeatable) |
| `--public` | Inject only promoted public keys |
| `--framework` | Apply framework prefix (vite, next) with --public |

## Examples

\`\`\`bash
# Basic: inject all env mappings
cnos run -- node server.js

# With profile override
cnos run --profile stage -- node server.js

# With inline override
cnos run --set value.server.port=9999 -- node server.js

# For frontend builds: only public values
cnos run --public --framework vite -- pnpm build
\`\`\`

## Related

- [cnos export env](./export.mdx) — export without spawning a process
- [cnos build server](./build.mdx) — generate projection file
```

## When Adding a New Page

1. Create the `.mdx` file in the appropriate directory.
2. Add the page to `packages/cnos-docs/manifest.yml` sidebar.
3. Run validation: `pnpm --filter @kitsy/cnos-docs validate`.
4. Verify internal links resolve.
