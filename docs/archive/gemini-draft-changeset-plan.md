# Dynamic Namespaces & Strict Promotion
Priority: High. This aligns the core data model with your vision of public.* as a first-class frontend runtime surface, while locking down secret.*.

What to build
Dynamic Namespaces: Remove hard-coded value, secret, meta from the core engine. Derive valid namespaces from a new namespaces block in .cnos/cnos.yml (with sensible defaults).

First-class public.* access: Enable frontend code to call cnos.read("public.flag.auth.upi_enabled") directly via a singleton runtime (or via the generated import.meta.env projection under the hood).

Strict Validation: Introduce a build/runtime assertion that aggressively throws an error if any user or config tries to promote a secret.* namespace key to public or env.

Expected cnos.yml Manifest Shape
YAML
namespaces:
  - value
  - secret
  - meta
  - public
  - env

public:
  promote:
    - value.flag.auth.upi_enabled # Can now be queried as public.flag.auth.upi_enabled

Implementation notes
Core Resolver: Update the resolver to accept namespaces from the manifest.

Promotion Logic: When building the resolved graph, if value.foo is in public.promote, create a mirrored alias entry in the graph under public.foo.

Validation Plugin: Add a hard-coded check in the public-env exporter: if a key starts with secret. and is found in the promote list, throw CnosSecurityError.

Frontend Runtime: The @kitsy/cnos-vite and @kitsy/cnos-next integrations must inject the promoted keys under the public.* namespace so cnos.read("public.x") resolves purely from the injected browser global or import.meta.env.

Tests
Manifest without namespaces block falls back to default (value, secret, meta).

Adding secret.db.password to public.promote throws CnosSecurityError during resolution.

cnos.read("public.flag") successfully resolves the underlying value.flag when promoted.

# Vault CLI & Remote Secret Providers
Priority: High. CI/CD adoption requires frictionless, passwordless secret access.

What to build
A dedicated CLI surface for Vault CRUD operations and support for passwordless remote vaults (like GitHub Actions secrets).

Commands
Bash
## New Vault Management
cnos vault create local-dev --provider local --passphrase dev-pass
cnos vault create github-ci --provider github-secrets --no-passphrase
cnos vault list
cnos vault remove local-dev

## Secret Management (updated to use vaults cleanly)
cnos secret set db.password super-secret --vault local-dev
cnos secret list --vault github-ci
Implementation notes
Vault Config: Store vault definitions in cnos.yml under a vaults: block, detailing the provider and whether a passphrase is required.

Provider Interface: Extend the secret loader plugin architecture to support remote fetchers. A provider: github-secrets loader will bypass local encrypted files and read directly from the GitHub Actions environment at runtime.

CLI Refactor: Extract vault into its own command module in @kitsy/cnos-cli.

Tests
cnos vault create writes the correct structure to the manifest.

Creating a vault with --no-passphrase successfully skips the encryption prompt and updates the manifest.

Remote provider loader successfully bypasses local filesystem lookups.

# Multi-Environment Exports (The CI/CD & .env Bridge)
Priority: Highest for immediate adoption. This serves users who aren't ready to drop their .env setups but want CNOS as their source of truth.

What to build
Enhance the cnos export env command to support robust profile targeting, allowing GitHub Actions and deployment pipelines to materialize framework-specific or backend .env files.

Commands
Bash
## Backend / Node.js
cnos export env --profile local > .env.local
cnos export env --profile stage > .env.stage
cnos export env --profile prod > .env.prod

## Frontend / Public Projections
cnos export env --public --framework vite --profile local > .env.local
cnos export env --public --framework next --profile prod > .env.production
Implementation notes
envMapping.explicit: Ensure the exporter strictly uses the explicit mappings defined in the manifest for backend exports.

CLI Flags: Add --profile flag to the export command. This overrides the default profile resolution just for the duration of the export.

Output Formatting: Ensure the standard out stream is pure KEY=VALUE formatting, free of any CNOS info logs, so it safely pipes into .env files.

Tests
cnos export env --profile stage outputs keys matching the stage profile overrides.

cnos export env --public --framework vite correctly prepends VITE_ to promoted keys.

Phase 7: App-Runtime Singleton DX & cnos run (The "Hero" Feature)
Priority: Highest for marketing and DX.

What to build
Zero-code integration: Make cnos run the primary entry point for apps so they don't have to change any code (they still read process.env).

Singleton Runtime: For apps that do want to use the native API, remove the friction of await createCnos() in every file by providing a synchronous cnos.read(...) singleton that initializes once.

Commands & Usage
Bash
# The Hero Command: Injects resolved config into process.env implicitly
cnos run --profile stage -- node server.js
cnos run --profile prod -- pnpm build
TypeScript
// The Singleton Usage (Node/Server)
import { cnos } from '@kitsy/cnos/runtime';

// Initializes synchronously using the state prepared by `cnos run`, 
// or auto-initializes async under the hood on first import.
const host = cnos.read("value.db.connection.host"); 
Implementation notes
cnos run Injection: cnos run must serialize the resolved explicit env mappings and inject them directly into the spawned child process's env object.

Singleton State: In @kitsy/cnos/runtime, create a global state object globalThis.__CNOS_RUNTIME__.

Bootstrapping: If cnos run was used to start the app, it should inject a pre-resolved, serialized graph into process.env.__CNOS_GRAPH__. The singleton can parse this synchronously, avoiding async initialization entirely.

Tests
cnos run correctly passes mapped env vars to a dummy node -e "console.log(process.env.PORT)" script.

cnos.read() successfully pulls from the globally bootstrapped graph without requiring await createCnos().