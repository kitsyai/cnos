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
cnos vault create db --passphrase dev-pass
cnos secret set db.password super-secret --vault db
```

### Read config in code

```ts
import { createCnos } from '@kitsy/cnos';

const cnos = await createCnos();

const appName = cnos.value('app.name');
const port = cnos.value('server.port');
const dbPassword = cnos.secret('db.password');
```

Or, when the process is started through `cnos run`, use the singleton:

```ts
import cnos from '@kitsy/cnos/runtime';

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
process.env.NEXT_PUBLIC_APP_API_BASE_URL
```

Server code can still use the runtime directly:

```ts
import { createCnos } from '@kitsy/cnos';

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
import { createCnos } from '@kitsy/cnos';

const cnos = await createCnos();
const dbHost = cnos.value('db.host');
const dbPassword = cnos.secret('db.password');
```

Browser-facing side:

```powershell
cnos export env --public
```

Recommended split:
- server-only config stays under `value.*` or `secret.*`
- browser-safe config is promoted with `public.promote`

## Profiles

Create and use profiles explicitly:

```powershell
cnos profile create stage --inherit base
cnos use --profile stage
cnos value set app.apiBaseUrl https://api.stage
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
cnos vault create default --passphrase dev-pass
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

The encrypted value is stored outside the repo.

You can avoid passing the passphrase every time by setting:

```powershell
$env:CNOS_SECRET_PASSPHRASE='dev-pass'
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
cnos vault create default --passphrase dev-pass
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
