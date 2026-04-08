# @kitsy/cnos-docs — Package Implementation Guide

**Purpose:** Set up the `@kitsy/cnos-docs` package as the source-of-truth documentation for CNOS. This package contains pure markdown/MDX content and a navigation manifest. It has no framework dependency — it's consumed by the Astro/Starlight docs builder.

**Location in monorepo:** `packages/cnos-docs/`

---

## 1. Package Structure

```
packages/cnos-docs/
  package.json
  manifest.yml                    # navigation structure + metadata
  docs/
    index.mdx                     # docs landing / overview
    getting-started/
      index.mdx                   # getting started overview
      installation.mdx
      quick-start.mdx
      your-first-project.mdx
    guides/
      backend.mdx                 # pure backend project
      frontend-vite.mdx           # Vite integration
      frontend-next.mdx           # Next.js integration
      ssr.mdx                     # SSR projects
      ci-cd.mdx                   # CI/CD pipelines
      workspaces.mdx              # monorepo / workspace setup
      profiles.mdx                # environment profiles
      secrets.mdx                 # vault and secret management
      migration.mdx               # migrating from .env / dotenv
    cli/
      index.mdx                   # CLI overview
      init.mdx
      value.mdx
      secret.mdx
      read.mdx
      inspect.mdx
      validate.mdx
      export.mdx
      run.mdx
      diff.mdx
      dump.mdx
      doctor.mdx
      promote.mdx
      codegen.mdx
      watch.mdx
      migrate.mdx
      drift.mdx
      vault.mdx
    api/
      index.mdx                   # API overview
      create-cnos.mdx
      runtime.mdx                 # CnosRuntime interface
      singleton.mdx               # @kitsy/cnos/runtime
      browser.mdx                 # @kitsy/cnos/browser
      types.mdx                   # LogicalKey, ConfigEntry, etc.
    reference/
      manifest.mdx                # cnos.yml full reference
      namespaces.mdx              # namespace model
      resolution.mdx              # precedence + merge rules
      security.mdx                # secret security model
    concepts/
      how-it-works.mdx            # mental model: sources → core → surfaces
      config-spectrum.mdx         # from .env to kube
  assets/
    images/
      architecture.png
      resolution-flow.png
      workspace-model.png
    diagrams/                     # source files for diagrams (mermaid, excalidraw, etc.)
```

---

## 2. package.json

```json
{
  "name": "@kitsy/cnos-docs",
  "version": "1.0.0",
  "private": false,
  "type": "module",
  "description": "Documentation content for CNOS configuration resolution system",
  "exports": {
    "./docs/*": "./docs/*",
    "./assets/*": "./assets/*",
    "./manifest": "./manifest.yml"
  },
  "files": [
    "docs",
    "assets",
    "manifest.yml"
  ],
  "keywords": ["cnos", "documentation", "kitsy"],
  "license": "MIT"
}
```

No dependencies. No build step. This package is pure content.

---

## 3. manifest.yml

```yaml
product: cnos
title: CNOS Documentation
tagline: Configuration resolution system for applications and monorepos
version: "1.0"

sidebar:
  - group: Getting Started
    items:
      - path: getting-started/index
        label: Overview
      - path: getting-started/installation
        label: Installation
      - path: getting-started/quick-start
        label: Quick Start
      - path: getting-started/your-first-project
        label: Your First Project

  - group: Guides
    items:
      - path: guides/backend
        label: Backend Projects
      - path: guides/frontend-vite
        label: Frontend (Vite)
      - path: guides/frontend-next
        label: Frontend (Next.js)
      - path: guides/ssr
        label: SSR Projects
      - path: guides/ci-cd
        label: CI/CD Pipelines
      - path: guides/workspaces
        label: Workspaces & Monorepos
      - path: guides/profiles
        label: Profiles & Environments
      - path: guides/secrets
        label: Secrets & Vaults
      - path: guides/migration
        label: Migrating from .env

  - group: CLI Reference
    collapsed: true
    items:
      - path: cli/index
        label: Overview
      - path: cli/init
        label: cnos init
      - path: cli/value
        label: cnos value
      - path: cli/secret
        label: cnos secret
      - path: cli/read
        label: cnos read
      - path: cli/inspect
        label: cnos inspect
      - path: cli/validate
        label: cnos validate
      - path: cli/export
        label: cnos export
      - path: cli/run
        label: cnos run
      - path: cli/diff
        label: cnos diff
      - path: cli/dump
        label: cnos dump
      - path: cli/doctor
        label: cnos doctor
      - path: cli/promote
        label: cnos promote
      - path: cli/vault
        label: cnos vault
      - path: cli/codegen
        label: cnos codegen
      - path: cli/watch
        label: cnos watch
      - path: cli/migrate
        label: cnos migrate
      - path: cli/drift
        label: cnos drift

  - group: API Reference
    collapsed: true
    items:
      - path: api/index
        label: Overview
      - path: api/create-cnos
        label: createCnos()
      - path: api/runtime
        label: CnosRuntime
      - path: api/singleton
        label: Singleton Runtime
      - path: api/browser
        label: Browser Runtime
      - path: api/types
        label: TypeScript Types

  - group: Reference
    collapsed: true
    items:
      - path: reference/manifest
        label: Manifest (cnos.yml)
      - path: reference/namespaces
        label: Namespaces
      - path: reference/resolution
        label: Resolution & Precedence
      - path: reference/security
        label: Security Model

  - group: Concepts
    collapsed: true
    items:
      - path: concepts/how-it-works
        label: How CNOS Works
      - path: concepts/config-spectrum
        label: The Config Spectrum
```

---

## 4. MDX Frontmatter Convention

Every `.mdx` file starts with YAML frontmatter:

```mdx
---
title: Installation
description: Install CNOS and get started in under 5 minutes.
---

# Installation

Install the CLI globally and the runtime as a project dependency.

```bash
npm install -g @kitsy/cnos-cli
npm install @kitsy/cnos
```
```

Required frontmatter fields: `title`, `description`.
Optional: `sidebar_label` (overrides label in sidebar), `sidebar_position` (overrides manifest order), `draft` (boolean, hides from production).

---

## 5. Content Guidelines

- **Markdown first.** Use MDX only when you need interactive components (rare). Standard markdown works for 95% of docs.
- **One topic per file.** Each file covers one concept, one CLI command, or one API surface.
- **Code examples are real.** Every code block should be copy-pasteable and working. No pseudocode in docs.
- **CLI examples use bash.** Use `bash` code fence language, not `shell` or `powershell` (bash is the universal default).
- **Admonitions** use standard syntax: `:::note`, `:::tip`, `:::caution`, `:::danger`. Starlight renders these natively.
- **Internal links** use relative paths: `[installation](./installation.mdx)`, not absolute URLs.
- **Images** reference from assets: `![Architecture](../../assets/images/architecture.png)`.

---

## 6. Starter Content to Write First

Priority order — write these first, everything else can be stubs:

1. `getting-started/quick-start.mdx` — the 5-minute path from zero to `cnos run`.
2. `getting-started/installation.mdx` — install CLI + runtime.
3. `guides/backend.mdx` — full backend walkthrough.
4. `cli/run.mdx` — the hero command.
5. `reference/manifest.mdx` — complete cnos.yml reference.
6. `guides/frontend-vite.mdx` — Vite integration.
7. `guides/secrets.mdx` — vault and secret management.

Everything else can be a stub file with just the frontmatter and a "Coming soon" note.

---

## 7. Validation

Add a simple validation script that checks:
- Every file in `docs/` has valid frontmatter (title + description).
- Every path referenced in `manifest.yml` has a corresponding file.
- No broken internal links.
- No orphan files (files not in manifest).

```json
{
  "scripts": {
    "validate": "node scripts/validate-docs.mjs"
  }
}
```

This runs in CI to prevent broken docs from being published.

---

## 8. Replication Pattern

To create `@kitsy/coop-docs`, `@kitsy/blu-docs`, etc.:

1. Copy the `packages/cnos-docs/` structure.
2. Update `package.json` name and description.
3. Update `manifest.yml` product name and sidebar.
4. Replace all content files.

The structure, conventions, frontmatter schema, and validation script are identical across all product docs packages.
