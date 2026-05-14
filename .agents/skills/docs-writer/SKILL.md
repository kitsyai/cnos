---
name: docs-writer
description: Writing documentation for the published CNOS docs package.
---

# Docs Writer Skill

You are writing documentation for the published docs package `@kitsy/cnos-docs`.

## Where Docs Live

- Content: `packages/docs/docs/`
- Navigation: `packages/docs/manifest.yml`
- Images: `packages/docs/assets/images/`
- Validation: `packages/docs/scripts/validate-docs.mjs`

The package directory is `packages/docs/`. The published package name remains `@kitsy/cnos-docs`.

## Source Of Truth

Before documenting behavior, check the canonical source for that surface:

- CLI commands, usage, flags, and examples: `packages/cli/src/cli/helpRegistry.ts`
- Machine-readable CLI output: `cnos help-ai --format json`
- Runtime and manifest contracts: `packages/core/src/types/*.ts`
- Higher-level repo guidance: `.agents/*.md`

Do not invent CLI flags, subcommands, or runtime methods from memory.

## Doc Structure

Use `packages/docs/manifest.yml` as the live table of contents. Do not trust a copied file list over the manifest.

Current high-level areas:

- `getting-started/`
- `guides/`
- `cli/`
- `api/`
- `reference/`
- `concepts/`

## Frontmatter

Every `.mdx` file must start with:

```yaml
---
title: Installation
description: Install CNOS and get started in under 5 minutes.
---
```

Required: `title`, `description`

## Writing Rules

- Every code example must be copy-pasteable and runnable.
- CLI examples use `bash` fences.
- Keep one topic per file.
- Use relative internal links.
- Keep language direct and concise.
- Show the simplest example first, then the advanced version.
- If a command page exists, keep its usage/options/examples aligned with `helpRegistry.ts`.

## Consistent Examples

Examples should follow repo conventions:

- `profiles.default: local`
- `base` as the conventional shared workspace in workspace-mode examples
- child workspaces usually `extends: [base]`
- `cnos run` as the lowest-friction runtime adoption path
- `cnos.value("server.port")` for runtime examples
- `cnos diff local stage`, not `cnos diff base stage`

## CLI Command Pages

Each CLI page should include:

1. usage
2. concise description
3. relevant flags/options
4. examples
5. related commands when helpful

When documenting a CLI command:

1. mirror the command name and usage from `helpRegistry.ts`
2. mirror the supported flags from `helpRegistry.ts`
3. avoid documenting hidden implementation aliases unless they are intentionally public
4. run docs validation after the edit

## When Adding Or Updating A Page

1. Create or edit the page in `packages/docs/docs/`.
2. Add or update the corresponding manifest entry in `packages/docs/manifest.yml`.
3. Run `pnpm --filter @kitsy/cnos-docs validate`.
4. If the page is for a top-level CLI command, make sure it matches `helpRegistry.ts`.
