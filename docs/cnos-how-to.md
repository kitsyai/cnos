# CNOS How-To

Practical setup guide for using CNOS in real projects.

This guide is aligned to the current shipped packages:
- `@kitsy/cnos`
- `@kitsy/cnos-cli`
- `@kitsy/cnos-vite`
- `@kitsy/cnos-next`
- `@kitsy/cnos-webpack`

## Before You Start

Global CLI install:

```powershell
npm install -g @kitsy/cnos-cli
cnos --version
cnos help
```

Core concepts:
- `.cnos/cnos.yml` is the local authoritative manifest.
- `.cnosrc.yml` is the consumer-side anchor that tells a package or app which `.cnos` root to use.
- values are private by default.
- public/browser exposure comes from `public.promote`.
- shell env export comes from `envMapping.explicit`.
- custom data namespaces such as `flags.*` can be written and promoted in v1 when declared under `namespaces`.
- `process.*` is a built-in server-only namespace for ambient runtime state such as `process.env.*`, `process.cwd`, and `process.node.version`.
- derived values let you compose config inside CNOS through `$derive`.
- `.cnosrc.yml` can point at either a local `.cnos` root or a remote git-backed root.
- local secret material is stored outside the repo under `~/.cnos/secrets`.

## Remote Roots

Use a remote root when config is authored in a separate config repo and consumed read-only by apps:

```yaml
root: git+https://github.com/org/config.git#v2.1.0
workspace: api
```

Useful cache commands:

```powershell
cnos cache list
cnos cache refresh
cnos cache clear
```

Remote roots resolve into the local CNOS cache and then behave like local roots for read/build/run flows. Writes to the config root are blocked, so manifest edits still happen in the source config repo.

## Derived Values

Template shorthand:

```yaml
app:
  origin:
    $derive: "${value.app.protocol}://${value.app.host}:${value.app.port}"
```

Expression form:

```yaml
app:
  effective_port:
    $derive:
      expr: "coalesce(process.env.PORT, value.app.default_port, '3000')"
```

CLI authoring:

```powershell
cnos value set app.origin --derive '${value.app.protocol}://${value.app.host}'
cnos value set app.effective_port --derive --expr "coalesce(process.env.PORT, value.app.default_port, '3000')"
```

Custom runtime namespaces are declared under `namespaces.runtime` and populated in code with `cnos.registerRuntimeProvider(namespace, provider)`.

## Migration Stories

Use the stack you already have as the bridge, then move reads to CNOS gradually.

### Plain Node or Express

Keep existing `dotenv` startup if the app already depends on it:

```powershell
cnos build env --profile local --to .env.local
cnos build env --profile stage --to .env.stage
```

Then start moving runtime reads to:

```ts
import cnos from '@kitsy/cnos';

await cnos.ready();
const port = cnos.readOr('value.server.port', 3000);
```

For deployment packaging:

```powershell
cnos build server --profile prod --to .cnos-server.json
```

For containerized runtime env:

```powershell
cnos build env --profile prod --format docker-env --to .docker/runtime/current.env
```

### Vite

Keep `VITE_*` working first:

```powershell
cnos build public --framework vite --profile local --to .env.local
cnos dev env --public --framework vite --profile local --to .env.local -- pnpm dev
```

Then move browser reads to `@kitsy/cnos/browser`.

For shared browser routing or cross-app links, keep the data in CNOS instead of introducing a second frontend config layer:

```yaml
public:
  promote:
    - value.apps.main.origin
    - value.apps.cnos.origin
    - value.apps.coop.origin
```

```ts
import cnos from '@kitsy/cnos/browser';

const mainOrigin = cnos('public.apps.main.origin');
const cnosOrigin = cnos('public.apps.cnos.origin');
```

That is the intended DX. Promote once, then read with `cnos('public.*')` anywhere in the browser app. The Vite or Next integration is responsible for making those values available before the UI code runs.

### Next.js

Keep `NEXT_PUBLIC_*` working first:

```powershell
cnos build public --framework next --profile prod --to .env.production
```

Then add `withCnosNext()` and move reads to `@kitsy/cnos/browser` for public values and `@kitsy/cnos` for server values.

### Webpack

Use `@kitsy/cnos-webpack` for browser-safe values and `createCnos()` in the webpack config for build-time settings like dev-server port.

### pnpm Monorepo

Keep one repo-root `.cnos/`, add `.cnosrc.yml` per consuming app/package, and only detach a child package if it truly needs to own config independently.

Example child anchor:

```yaml
root: ../../.cnos
workspace: travel
```

### Docker / Docker Compose / Kubernetes / GitHub Actions

Use CNOS-generated artifacts, not hand-maintained runtime env files.

Docker or Docker Compose:

```powershell
cnos build env --profile local-domain --format docker-env --to .docker/runtime/current.env
docker compose up --build
```

Recommended compose pattern:

```yaml
services:
  app:
    env_file:
      - ./.docker/runtime/current.env
```

Kubernetes:

```powershell
cnos build env --profile stage --format yaml --to k8s/generated/app-config.yaml
```

GitHub Actions:

```yaml
- name: Build CNOS env
  run: cnos build env --profile stage --to .env.stage

- name: Build app
  run: pnpm build
```

For server packaging in CI:

```powershell
cnos build server --profile prod --to dist/.cnos-server.json
```

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

Values can be structured, not just strings:

```powershell
cnos value set flags.upi_enabled false
cnos value set api.default_query_params '["ab", "bc"]'
cnos value set app.theme '{ primary: blue, density: compact }'
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

For projection-first packaging, build a server artifact:

```powershell
cnos build server --to .cnos-server.json
```

`@kitsy/cnos` auto-loads from `__CNOS_PROJECTION__`, then `.cnos-server.json`, then falls back to full authoring resolution through `.cnosrc.yml`.

Other runtime helpers:

```ts
const port = cnos.readOr('value.server.port', 3000);
const flags = cnos.toNamespace('flags');
const exported = cnos.toEnv();
const publicEnv = cnos.toPublicEnv();
```

There are no `readAsString()` / `readAsNumber()` helpers in the current runtime. Use `read<T>()`, `require<T>()`, `readOr()`, or the namespace helpers.

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
cnos build env --profile local --to .env.local
cnos build server --profile stage --to dist/.cnos-server.json
cnos export env --profile stage --to .env.stage
cnos build env --profile stage --to .env.stage
cnos dev env --profile local --to .env.local -- pnpm dev
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

### Process namespace

Use `process.*` when you need to inspect ambient server runtime state without mixing it into CNOS export surfaces.

```powershell
cnos read process.cwd
cnos list process --prefix env.PATH
cnos inspect process.env.PATH
```

Rules:
- `process.*` is read-only
- `process.*` is server-only
- `process.*` cannot be promoted to `public.*`
- `process.*` cannot be exported through `envMapping.explicit`

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

For multi-app frontends, use the same pattern for shared public origins:

```yaml
public:
  promote:
    - value.apps.main.origin
    - value.apps.docs.origin
```

```ts
import cnos from '@kitsy/cnos/browser';

const docsOrigin = cnos('public.apps.docs.origin');
window.location.href = `${docsOrigin}/getting-started`;
```

Useful checks:

```powershell
cnos list public
cnos export env --public --framework vite
cnos build public --framework vite --to .env.local
cnos build env --public --framework vite --to .env.local
cnos export env --public --framework vite --to .env.local
```

### Webpack

Use `@kitsy/cnos-webpack` when webpack produces the browser bundle.

Simple highlight:

```powershell
cnos set value dev.server.port 8800
npm run dev
```

Typical result:

```text
set value.dev.server.port in .cnos\values\dev.yml
Cnos value.dev.server.port: 8800
[webpack-dev-server] Project is running at:
[webpack-dev-server] Loopback: http://localhost:8800/
```

This is the intended DX: update one CNOS key and let webpack pick it up through `createCnos()`.

```ts
import { createCnos } from '@kitsy/cnos/configure';
import { CnosWebpackPlugin } from '@kitsy/cnos-webpack';

export default async () => {
  const cnos = await createCnos({
    profile: process.env.NODE_ENV === 'production' ? 'prod' : 'local',
  });

  return {
    devServer: {
      port: Number(cnos.readOr('value.devServer.port', 3000)),
    },
    plugins: [
      new CnosWebpackPlugin({
        profile: process.env.NODE_ENV === 'production' ? 'prod' : 'local',
      }),
    ],
  };
};
```

Read in browser code:

```ts
import cnos from '@kitsy/cnos/browser';

console.log(cnos('public.app.apiBaseUrl'));
console.log(cnos('public.flags.upi_enabled'));
console.log(process.env.APP_API_BASE_URL);
```

Recommended plugin order:

```ts
plugins: [
  new CnosWebpackPlugin({ profile }),
  new HtmlWebpackPlugin(...),
  new MiniCssExtractPlugin(...),
  new CopyPlugin(...),
  new ESLintPlugin(...),
]
```

Notes:
- keep `CnosWebpackPlugin` near the top of the plugin list
- for build-time server settings like `devServer.port`, read them through `createCnos()` in the webpack config
- for HTML template values, read them through `createCnos()` and pass them to `HtmlWebpackPlugin.templateParameters`

If your webpack config is CommonJS, do not mix top-level `await` with `require(...)` in a file webpack treats as ESM. Use:

```js
module.exports = async () => {
  const { createCnos } = await import('@kitsy/cnos/configure');
  const { CnosWebpackPlugin } = await import('@kitsy/cnos-webpack');
  // ...
};
```

If webpack-cli shows `file:///.../webpack.config.js`, it loaded your config as ESM, so `require(...)` is unavailable.

### Other bundlers

For generic bundlers or custom build scripts, use `@kitsy/cnos/build`:

```ts
import { resolveBrowserData, toFrameworkEnv } from '@kitsy/cnos/build';

const browserData = await resolveBrowserData({ profile: 'stage' });
const genericEnv = toFrameworkEnv(browserData, 'generic');
```

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
cnos build env --public --framework next --to .env.production
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

For env-file-based dev loops, prefer:

```powershell
cnos dev env --profile local --to .env.local -- pnpm dev
cnos dev env --public --framework vite --to .env.local --signal -- pnpm dev
```

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
cnos init
cnos workspace add api --package-root apps/api --extends base
cnos workspace add admin --package-root apps/admin --extends base
cnos workspace list
```

Override per command when needed:

```powershell
cnos list values --workspace webapp
```

If you initialized CNOS earlier in regular single-root mode and want to convert that existing `.cnos` tree into a workspace:

```powershell
cnos workspace enable
```

For package-level consumers inside a pnpm monorepo, add a `.cnosrc.yml` beside the package `package.json`:

```yaml
root: ../../.cnos
workspace: travel
```

CNOS only discovers `.cnosrc.yml`, not `.cnos`, and the search is bounded to a small package-root window.

If a child package needs to become self-contained:

```powershell
cnos workspace detach --package-root apps/travel
```

To reattach later:

```powershell
cnos workspace attach --package-root apps/travel
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
