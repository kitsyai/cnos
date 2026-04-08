# CNOS How-To

Practical setup guide for using CNOS in real projects.

This guide is aligned to the current shipped packages:
- `@kitsy/cnos`
- `@kitsy/cnos-cli`
- `@kitsy/cnos-vite`
- `@kitsy/cnos-next`

## Before You Start

Global CLI install:

```powershell
npm install -g @kitsy/cnos-cli
cnos --version
cnos help
```

Core concepts:
- `.cnos/cnos.yml` is the local authoritative manifest.
- values are private by default.
- public/browser exposure comes from `public.promote`.
- shell env export comes from `envMapping.explicit`.
- custom data namespaces such as `flags.*` can be written and promoted in v1 when declared under `namespaces`.
- local secret material is stored outside the repo under `~/.cnos/secrets`.

## 1. Pure Backend Project

Use this for Node services, API servers, workers, CLIs, or any backend-only app.

### Scaffold

```powershell
cnos init
cnos doctor
```

### Define config

```powershell
cnos value set server.port 3000
cnos value set db.host localhost
cnos value set app.name my-service
```

### Define a local secret

```powershell
cnos vault create db
cnos vault auth db
cnos secret set db.password super-secret --vault db
```

`cnos vault create <name>` initializes the local encrypted vault immediately. If `CNOS_SECRET_PASSPHRASE_<VAULT>` or `CNOS_SECRET_PASSPHRASE` is not set and no keychain entry exists, CNOS prompts for the passphrase at create time. `cnos vault auth <name>` only re-authenticates an existing vault and fails on a wrong passphrase.

### Read config in code

```ts
import { createCnos } from '@kitsy/cnos/configure';

const cnos = await createCnos();

const appName = cnos.value('app.name');
const port = cnos.value('server.port');
const dbPassword = cnos.secret('db.password');
```

Or, when the process is started through `cnos run`, use the singleton:

```ts
import cnos from '@kitsy/cnos';

const port = cnos('value.server.port');
const dbPassword = cnos.secret('db.password');
```

### Run the service with CNOS-injected env

First map explicit env exports in `.cnos/cnos.yml`:

```yaml
envMapping:
  explicit:
    PORT: value.server.port
    DB_HOST: value.db.host
```

Then:

```powershell
cnos export env
cnos export env --to .env.local
cnos export env --profile stage --to .env.stage
cnos run -- node server.js
cnos run --set value.server.port=9999 -- node server.js
```

### Recommended sanity checks

```powershell
cnos list values
cnos list env
cnos inspect value.server.port
cnos validate
```

### Custom data namespaces

You can declare additional writable data namespaces and use them like `value.*` in code and CLI.

```yaml
namespaces:
  flags:
    kind: data
    shareable: true

public:
  promote:
    - flags.upi_enabled

envMapping:
  explicit:
    FLAGS_UPI_ENABLED: flags.upi_enabled
```

Then:

```powershell
cnos set flags.upi_enabled false
cnos get flags.upi_enabled
cnos list flags
cnos promote flags.upi_enabled --to public
cnos promote flags.upi_enabled --to env --as FLAGS_UPI_ENABLED
```

In server code:

```ts
import cnos from '@kitsy/cnos';

await cnos.ready();
console.log(cnos('flags.upi_enabled'));
console.log(cnos('public.flags.upi_enabled'));
```

## 2. Pure Frontend Static Bundle

Use this for browser-only apps built with Vite today. Webpack is not first-party yet, so use the generic public env pattern there.

### Vite project

Install:

```powershell
pnpm add @kitsy/cnos @kitsy/cnos-vite
```

Promote public values in `.cnos/cnos.yml`:

```yaml
public:
  promote:
    - value.app.apiBaseUrl
```

Set values:

```powershell
cnos value set app.apiBaseUrl https://api.local
```

Wire Vite:

```ts
import { defineConfig } from 'vite';
import { createCnosVitePlugin } from '@kitsy/cnos-vite';

export default defineConfig({
  plugins: [createCnosVitePlugin()],
});
```

Read in client code:

```ts
import cnos from '@kitsy/cnos/browser';

console.log(cnos('public.app.apiBaseUrl'));
console.log(import.meta.env.VITE_APP_API_BASE_URL);
```

Useful checks:

```powershell
cnos list public
cnos export env --public --framework vite
cnos export env --public --framework vite --to .env.local
```

### Webpack or other bundlers

There is no first-party Webpack integration yet.

Current working approach:
- keep public values in `public.promote`
- use `cnos export env --public`
- inject those values into your bundler build step with your existing DefinePlugin or env loading path

Example:

```powershell
cnos export env --public > .cnos-public.env
```

Then load that file in your bundler setup.

## 3. SSR Projects

Use this when both server code and browser UI exist.

There are two common modes:
- Next.js
- generic SSR server plus frontend bundle

### Next.js

Install:

```powershell
pnpm add @kitsy/cnos @kitsy/cnos-next
```

Promote browser-safe values:

```yaml
public:
  promote:
    - value.app.apiBaseUrl
```

Wire Next:

```ts
import { withCnosNext } from '@kitsy/cnos-next';

export default withCnosNext({});
```

Browser-safe values land as:

```ts
import cnos from '@kitsy/cnos/browser';

cnos('public.app.apiBaseUrl');
process.env.NEXT_PUBLIC_APP_API_BASE_URL
```

Server code can still use the runtime directly:

```ts
import { createCnos } from '@kitsy/cnos/configure';

const cnos = await createCnos();
const secret = cnos.secret('db.password');
```

Checks:

```powershell
cnos export env --public --framework next
cnos export env --public --framework next --to .env.production
cnos inspect value.app.apiBaseUrl
```

### Generic SSR

Use `@kitsy/cnos` directly in the server process and export only public values to the browser build/runtime.

Server:

```ts
import { createCnos } from '@kitsy/cnos/configure';

const cnos = await createCnos();
const dbHost = cnos.value('db.host');
const dbPassword = cnos.secret('db.password');
```

Browser-facing side:

```powershell
cnos export env --public
```

Or use the browser runtime when your bundler integration embeds CNOS browser data:

```ts
import cnos from '@kitsy/cnos/browser';

const apiBaseUrl = cnos('public.app.apiBaseUrl');
```

## 4. Daily Maintenance Workflows

These commands are useful once CNOS is already adopted in a repo.

### Generate typed accessors

Use `codegen` when your manifest schema is stable enough that you want generated types checked into the repo or consumed in app code.

```powershell
cnos codegen
cnos codegen --out src/cnos-config.d.ts
cnos codegen --watch
```

This generates:
- `.cnos/types/cnos.d.ts`
- `.cnos/types/runtime.ts`

Typical use:
- run after schema changes
- run in CI to keep generated types current
- use `--watch` while shaping the config model

### Watch config and restart processes

Use `watch` when a local dev process should restart or react when `.cnos` files change.

```powershell
cnos watch -- node server.js
cnos watch --debounce 100 -- pnpm dev
cnos watch --signal
```

Modes:
- restart mode: reruns the child process with updated CNOS env/runtime bootstrap
- signal mode: prints changed logical keys as JSON and does not spawn a child

Use signal mode when another tool is responsible for reloads.

### Detect schema drift

Use `drift` to compare the resolved graph against the declared schema.

```powershell
cnos drift
cnos drift --profile stage
cnos drift --json
```

Drift reports:
- missing required keys
- undeclared keys
- type mismatches
- defaults applied from schema

This is useful in CI before release or deploy.

### Migrate existing env usage

Use `migrate` when adopting CNOS in a repo that still relies on `process.env` or `import.meta.env`.

```powershell
cnos migrate
cnos migrate --scan src --dry-run
cnos migrate --apply
cnos migrate --apply --rewrite
```

Behavior:
- dry-run reports discovered env usage and proposed CNOS mappings
- apply mode updates `.cnos/cnos.yml` with `envMapping.explicit` and `public.promote`
- rewrite mode creates `.bak` backups and rewrites directly supported `process.env.*` usages

Recommended migration flow:
1. `cnos migrate --scan src --dry-run`
2. inspect the proposed mappings
3. `cnos migrate --apply`
4. `cnos migrate --apply --rewrite`
5. run `cnos validate` and `cnos drift`

## 5. Help Surfaces

For humans:

```powershell
cnos help
cnos <command> --help
```

For agents and tooling:

```powershell
cnos help-ai --format json
cnos help-ai migrate --format json
cnos help-ai watch --format json
```

`help` and `help-ai` are generated from the same command registry, so new command help should stay aligned with the CLI surface.

Recommended split:
- server-only config stays under `value.*` or `secret.*`
- browser-safe config is promoted with `public.promote`

## Profiles

Create and use profiles explicitly:

```powershell
cnos profile create stage
cnos use --profile stage
cnos value set app.apiBaseUrl https://api.stage
```

Profiles inherit values from `base` by default. If you need a clean profile with no base fallback, use:

```powershell
cnos profile create isolated --no-inherit
```

Checks:

```powershell
cnos inspect value.app.apiBaseUrl --profile stage
cnos diff base stage
```

## Workspaces

Single-project repos can stay simple.

If you use multiple workspaces:

```powershell
cnos init --workspace api
cnos use --workspace api
cnos list values
```

Override per command when needed:

```powershell
cnos list values --workspace webapp
```

## Secrets

Recommended local secret flow:

```powershell
cnos vault create default
cnos vault auth default
cnos secret set app.token super-secret --vault default
```

Repo YAML stores only refs, for example:

```yaml
app:
  token:
    provider: local
    vault: default
    ref: app.token
```

The encrypted value is stored outside the repo. Auth comes from env, keychain, or an interactive prompt.

For non-interactive shells, set:

```powershell
$env:CNOS_SECRET_PASSPHRASE='dev-pass'
$env:CNOS_SECRET_PASSPHRASE_DEFAULT='dev-pass'
```

For CI-style passwordless refs, create a GitHub-backed vault:

```powershell
cnos vault create github-ci --provider github-secrets --no-passphrase
cnos secret set app.token APP_TOKEN --vault github-ci
```

At runtime, CNOS resolves that ref from the current process environment:

```powershell
$env:APP_TOKEN='ci-secret'
cnos secret get app.token --vault github-ci
```

## Smoke Test Checklist

Use this as a quick sanity pass after install:

```powershell
cnos --version
cnos help
cnos help-ai --format json
cnos init
cnos use show
cnos doctor
cnos value set app.id demo-id
cnos read value.app.id
cnos inspect value.app.id
cnos list values
cnos list env
cnos profile create stage --inherit base
cnos vault create default
cnos vault auth default
cnos secret set app.token super-secret --vault default
cnos vault create github-ci --provider github-secrets --no-passphrase
cnos secret set ci.token APP_TOKEN --vault github-ci
cnos secret list --vault github-ci
cnos validate
cnos export env
```

Frontend/Vite extra:

```powershell
cnos list public
cnos export env --public --framework vite
```

SSR/Next extra:

```powershell
cnos export env --public --framework next
```
