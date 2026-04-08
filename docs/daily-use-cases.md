# Concrete Use Cases

Here are 5 concrete, everyday use cases that cnos should flawlessly support from day one, expanding on your ideas:

## 1. The "Fail-Fast" App Startup (Type Safety & Validation)

The Pain: An application deploys successfully but crashes 10 minutes later because a required database connection string was missing or a port number was parsed as a string instead of an integer.

The CNOS Solution: Before the server even starts, cnos should validate the resolved config graph against a schema and throw a descriptive error if anything is missing or malformed.

How it looks in code:

```typeScript
import cnos from '@kitsy/cnos';
import { z } from 'zod'; // Or built-in cnos validation

// Define the required shape
const configSchema = z.object({
  db: z.object({
    host: z.string(),
    port: z.number().default(5432),
  }),
  apiKey: z.string().min(1)
});

// CNOS resolves from all sources, then validates
const safeConfig = cnos.validate(configSchema); 

// Now developers get autocomplete and type-safety
console.log(safeConfig.db.host); 
```

## 2. The Local Developer Override (Precedence Management)

The Pain: A developer needs to point their local frontend to a staging backend instead of the local dev server. They manually edit a shared config.json, accidentally commit it, and break the build for everyone else.

The CNOS Solution: Flawless precedence resolution. cnos should clearly define that CLI args beat .env.local, which beats .env, which beats config.default.json.

How it looks in practice:
The developer just runs their start command with a CLI override, and cnos handles the rest without touching the source files. `cnos run` provides the lowest-friction path where the app code doesn't change at all — it still reads process.env. Once teams use cnos run and see the value of profiles, workspaces, and inspection, they'll adopt the runtime API voluntarily. I'd make cnos run the hero feature in all docs and marketing.

```bash
# Application code still just reads cnos("api.url")
cnos run dev --set api.url=https://staging.api.kitsy.ai
# server
cnos run -- node server.js
cnos run --profile stage -- pnpm build
```

## 3. The Frontend "Safe Projection" (Build-Time Export)

(Expanding on your Point 1)

The Pain: Accidental leakage of backend secrets into frontend bundles. Furthermore, Vite, Next.js, and Create React App all expect environment variables to be prefixed differently (VITE_, NEXT_PUBLIC_, REACT_APP_).

The CNOS Solution: A CLI tool or plugin that projects the logical cnos graph into a framework-specific flat .env file, automatically stripping out anything not explicitly marked as "public".

How it looks in the pipeline:

```bash
# Extracts only keys tagged as 'public', prefixes them with NEXT_PUBLIC_, 
# and flattens the graph for Next.js to consume during build time.
cnos export --surface frontend --framework nextjs > .env.local

npm run build
```

## 4. The Monorepo Cascade (Workspace Inheritance)

The Pain: In a monorepo (e.g., using Turborepo or Nx), you have multiple apps (api, web, docs) and packages. Maintaining separate configs for each leads to drift (e.g., mismatched logging levels or shared API URLs).

The CNOS Solution: Namespace and workspace inheritance. A root cnos config defines the company-wide defaults, while workspace-specific configs inherit and override them.

How it looks in code:

```plaintext
/kitsy-repo
  ├── cnos.yml (Root: defines default logging=info)
  ├── /apps
      ├── /api
      │   └── cnos.yml (Inherits root, sets db connections)
      └── /web
          └── cnos.yml (Inherits root, overrides logging=debug)
```

When running the api project, cnos("logging.level") resolves to info. When running the web project, it resolves to debug.

5. CI/CD Secret Hydration (Deployment Runtimes)
(Expanding on your Points 3 & 4)
The Pain: Moving code from GitHub Actions to AWS/Vercel/Kubernetes requires duplicating secret configurations across multiple platform dashboards.
The CNOS Solution: The application code remains completely ignorant of the environment. In the CI pipeline, cnos uses a loader plugin (like @kitsy/cnos-loader-github-secrets or AWS Secrets Manager) to fetch the real values and pass them as a flattened environment variable map to the deployment runtime.

How it looks in a GitHub Action:

```yaml
steps:
  - name: Build and Deploy
    run: |
      # cnos pulls logical keys, hydrates them from GitHub secrets, 
      # and injects them into the node process.
      cnos inject --loader github-secrets -- node dist/server.js
```
