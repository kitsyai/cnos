export interface HelpArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface HelpOption {
  flag: string;
  description: string;
}

export interface HelpCommand {
  id: string;
  summary: string;
  usage: string;
  description: string;
  arguments?: HelpArgument[];
  options?: HelpOption[];
  examples?: string[];
}

export interface HelpIntegration {
  id: string;
  packageName: string;
  entrypoint: string;
  summary: string;
  usage: string;
  examples?: string[];
}

export interface HelpDocument {
  name: string;
  summary: string;
  usage: string;
  description: string;
  globalOptions: HelpOption[];
  commands: HelpCommand[];
  integrations: HelpIntegration[];
  examples: string[];
  /**
   * Well-known flags that CNOS runtimes pick up from the application process argv,
   * independent of the `cnos` CLI itself. Documented here for discoverability.
   */
  runtimeFlags?: HelpOption[];
}

const GLOBAL_OPTIONS: HelpOption[] = [
  {
    flag: '--root <path>',
    description: 'Resolve the CNOS project from a specific filesystem root or remote root URI.',
  },
  {
    flag: '--workspace <id>',
    description: 'Select the active workspace for this invocation.',
  },
  {
    flag: '--profile <name>',
    description: 'Override the active profile for reads, export, diff, and run.',
  },
  {
    flag: '--global-root <path>',
    description: 'Override the configured global CNOS root used for workspace layering.',
  },
  {
    flag: '--cache-ttl <seconds>',
    description: 'Override the remote-root cache TTL for mutable refs during this invocation.',
  },
  {
    flag: '--use-private',
    description: 'Include profile values and secret refs from private layers during runtime resolution.',
  },
  {
    flag: '--json',
    description: 'Emit JSON output for commands that support structured responses.',
  },
  {
    flag: '--verbose',
    description: 'Print full stack traces and verbose diagnostics for command failures.',
  },
  {
    flag: '--help, -h',
    description: 'Show command help.',
  },
];

const COMMANDS: HelpCommand[] = [
  {
    id: 'cache',
    summary: 'Inspect and manage cached remote roots.',
    usage: 'cnos cache [list|clear|refresh] [root-uri] [global-options]',
    description:
      'Lists cached git-backed remote roots, clears cache entries, or forces a refresh for mutable refs.',
    examples: [
      'cnos cache list',
      'cnos cache clear',
      'cnos cache clear git+https://github.com/org/config.git#v2.1.0',
      'cnos cache refresh',
    ],
  },
  {
    id: 'cache list',
    summary: 'List cached remote roots.',
    usage: 'cnos cache list [global-options]',
    description:
      'Lists git-backed remote roots cached under ~/.cnos/cache together with cache time, resolved commit, immutability, and size.',
    examples: ['cnos cache list'],
  },
  {
    id: 'cache clear',
    summary: 'Clear cached remote roots.',
    usage: 'cnos cache clear [root-uri] [global-options]',
    description:
      'Removes all cached remote roots by default, or clears one specific cached root when a full remote URI is provided.',
    examples: ['cnos cache clear', 'cnos cache clear git+https://github.com/org/config.git#main'],
  },
  {
    id: 'cache refresh',
    summary: 'Force refresh mutable cached remote roots.',
    usage: 'cnos cache refresh [root-uri] [global-options]',
    description:
      'Re-fetches a specific git-backed remote root, or refreshes the active remote root / all mutable cached roots when no URI is provided.',
    examples: ['cnos cache refresh', 'cnos cache refresh git+ssh://git@github.com/org/config.git#main'],
  },
  {
    id: 'init',
    summary: 'Scaffold a CNOS project in regular mode or workspace mode.',
    usage: 'cnos init [--mode <regular|workspace>] [--workspaces <csv>] [--root <path>] [--json]',
    description:
      'Creates .cnos/cnos.yml, .cnosrc.yml, config folders, and .gitignore entries without overwriting existing files. Regular mode is the default; workspace mode creates base plus optional child workspaces.',
    examples: [
      'cnos init',
      'cnos init --mode workspace',
      'cnos init --mode workspace --workspaces api,web,agents',
      'cnos init --root ./apps/api --json',
    ],
  },
  {
    id: 'onboard',
    summary: 'Import existing env or config sources into CNOS and propose value.* mappings.',
    usage: 'cnos onboard [--workspace <id>] [--env <path>|--yaml <path>|--json <path>|--toml <path>|--config <path>] [--materialize|--source-only] [--prefix <path>] [--move] [--root <path>] [--json]',
    description:
      'Auto-discovers root .env* files by default, copies them into CNOS source storage, prints proposed value.* mappings, and can materialize those mappings into CNOS values. In workspace mode, imports land in the selected workspace; otherwise they land in the implicit base layer.',
    options: [
      {
        flag: '--env <path>',
        description: 'Import one dotenv file instead of auto-discovering root .env* files.',
      },
      {
        flag: '--yaml <path>',
        description: 'Import one YAML config file and flatten it into value.* keys.',
      },
      {
        flag: '--json <path>',
        description: 'Import one JSON config file and flatten it into value.* keys.',
      },
      {
        flag: '--toml <path>',
        description: 'Import one TOML config file and flatten it into value.* keys.',
      },
      {
        flag: '--config <path>',
        description: 'Import one config file using extension-based format detection.',
      },
      {
        flag: '--materialize',
        description: 'Write the proposed value.* mappings without prompting.',
      },
      {
        flag: '--source-only',
        description: 'Copy the source file(s) into CNOS storage but skip value materialization.',
      },
      {
        flag: '--prefix <path>',
        description: 'Scope imported keys under value.<prefix>.*.',
      },
      {
        flag: '--move',
        description: 'Move the source files into CNOS instead of leaving the originals in place.',
      },
    ],
    examples: [
      'cnos onboard',
      'cnos onboard --env .env.production --materialize',
      'cnos onboard --yaml config/app.yml --prefix app',
      'cnos onboard --workspace api --config config/api.toml',
    ],
  },
  {
    id: 'codegen',
    summary: 'Generate typed CNOS access wrappers from schema.',
    usage: 'cnos codegen [--out <path>] [--watch] [--root <path>]',
    description:
      'Reads schema from .cnos/cnos.yml and generates typed CNOS declaration output plus a typed createCnos wrapper.',
    options: [
      {
        flag: '--out <path>',
        description: 'Custom path for the generated type declaration file. runtime.ts is emitted beside it.',
      },
      {
        flag: '--watch',
        description: 'Watch the manifest schema and regenerate output when it changes.',
      },
    ],
    examples: ['cnos codegen', 'cnos codegen --out src/cnos-config.d.ts', 'cnos codegen --watch'],
  },
  {
    id: 'read',
    summary: 'Read any fully-qualified CNOS key.',
    usage: 'cnos read <key> [global-options]',
    description: 'Reads a fully-qualified key such as value.app.name or secret.app.token.',
    arguments: [
      {
        name: 'key',
        description: 'Fully-qualified key to read.',
        required: true,
      },
    ],
    examples: ['cnos read value.app.name', 'cnos read secret.app.token --workspace api'],
  },
  {
    id: 'value',
    summary: 'Read, write, list, and delete values.',
    usage: 'cnos value [get <path> | set <path> <value> | list | delete <path>] [options] [global-options]',
    description: 'Reads and manages value.<path> entries from the selected workspace and profile.',
    arguments: [
      {
        name: 'path',
        description: 'Value path without the value. namespace prefix.',
      },
    ],
    options: [
      {
        flag: '--target <local|global>',
        description: 'Choose whether writes land in the local project workspace or the configured global root.',
      },
      {
        flag: '--derive',
        description: 'Write a derived value instead of a literal. Use the second positional value as a template, or combine with --expr.',
      },
      {
        flag: '--expr <expression>',
        description: 'With --derive, write an expression-form derived value instead of template shorthand.',
      },
      {
        flag: '--prefix <path>',
        description: 'Filter value list output to keys that begin with this logical path or key prefix.',
      },
    ],
    examples: [
      'cnos value app.name',
      'cnos value set server.port 3000',
      "cnos value set app.origin --derive '${value.app.protocol}://${value.app.host}'",
      `cnos value set app.display_name --derive --expr "coalesce(value.app.custom_name, value.app.name, 'Unnamed')"`,
      'cnos add value app.name demo',
      'cnos value list --prefix app.',
    ],
  },
  {
    id: 'value set',
    summary: 'Write a value.',
    usage: 'cnos value set <path> <value> [--target <local|global>] [--derive] [--expr <expression>] [global-options]',
    description: 'Writes either a literal value or a first-class derived value into the selected workspace or explicit global target.',
    options: [
      {
        flag: '--target <local|global>',
        description: 'Choose whether writes land in the local project workspace or the configured global root.',
      },
      {
        flag: '--derive',
        description: 'Interpret the provided value as a derived template, or combine with --expr for expression syntax.',
      },
      {
        flag: '--expr <expression>',
        description: 'With --derive, store the value as an expression-form derivation instead of template shorthand.',
      },
    ],
    examples: [
      'cnos value set app.name demo',
      "cnos value set app.origin --derive '${value.app.protocol}://${value.app.host}'",
      `cnos value set app.display_name --derive --expr "coalesce(value.app.custom_name, value.app.name, 'Unnamed')"`,
      'cnos add value server.port 3000 --target global',
    ],
  },
  {
    id: 'value list',
    summary: 'List resolved values.',
    usage: 'cnos value list [--prefix <path>] [global-options]',
    description: 'Lists resolved value keys for the selected workspace and profile.',
    examples: ['cnos value list', 'cnos value list --prefix app.'],
  },
  {
    id: 'value delete',
    summary: 'Delete a value entry.',
    usage: 'cnos value delete <path> [--target <local|global>] [global-options]',
    description: 'Deletes a value from the selected workspace or explicit global target.',
    examples: ['cnos value delete app.name', 'cnos remove value server.port'],
  },
  {
    id: 'secret',
    summary: 'Read, write, list, and delete secrets.',
    usage: 'cnos secret [get <path> | set <path> <value> | list | delete <path>] [options] [global-options]',
    description:
      'Reads resolved secrets, writes secret refs plus external local-secret material, and manages secret entries for the selected workspace and profile.',
    arguments: [
      {
        name: 'path',
        description: 'Secret path without the secret. namespace prefix.',
      },
    ],
    options: [
      {
        flag: '--local',
        description: 'Store encrypted secret material under ~/.cnos/secrets and write a local ref into the repo.',
      },
      {
        flag: '--remote',
        description: 'Write a remote secret reference into the repo.',
      },
      {
        flag: '--ref',
        description: 'Write a generic secret reference into the repo.',
      },
      {
        flag: '--provider <name>',
        description: 'Provider name for remote/reference secret metadata writes.',
      },
      {
        flag: '--vault <name>',
        description:
          'Use a manifest-defined vault. Local vaults store encrypted material; non-local vaults write reference metadata only.',
      },
      {
        flag: '--reveal',
        description: 'Reveal the resolved secret value for get-style reads. Output is masked by default.',
      },
    ],
    examples: [
      'cnos secret app.token',
      'cnos vault create local-dev',
      'cnos vault auth local-dev',
      'cnos secret set app.token super-secret --vault local-dev',
      'cnos vault create github-ci --provider environment --no-passphrase',
      'cnos secret set app.token APP_TOKEN --vault github-ci',
      'cnos secret set app.token --vault prod-gcp',
    ],
  },
  {
    id: 'vault',
    summary: 'Manage manifest-defined secret vaults.',
    usage: 'cnos vault [create <name> | list | remove <name>] [options] [global-options]',
    description:
      'Creates, lists, and removes vault definitions in .cnos/cnos.yml. Local vaults use encrypted material under ~/.cnos/secrets, while environment-backed vaults resolve from process.env in CI and cloud runtimes. github-secrets remains a compatibility alias.',
    options: [
      {
        flag: '--provider <local|environment|github-secrets>',
        description: 'Vault provider. Defaults to local.',
      },
      {
        flag: '--no-passphrase',
        description: 'Allowed for passwordless providers such as environment-backed vaults.',
      },
    ],
    examples: [
      'cnos vault create local-dev',
      'cnos vault auth local-dev',
      'cnos vault create github-ci --provider environment --no-passphrase',
      'cnos vault list',
      'cnos vault remove local-dev',
    ],
  },
  {
    id: 'vault create',
    summary: 'Create a manifest-defined vault.',
    usage: 'cnos vault create <name> [--provider <local|environment|github-secrets>] [--no-passphrase] [global-options]',
    description:
      'Creates a vault definition in .cnos/cnos.yml and, for local vaults, initializes the encrypted store under ~/.cnos/secrets. CNOS prompts for a passphrase when one is not already available from env or keychain.',
    examples: [
      'cnos vault create local-dev',
      'cnos vault create firebase-prod --provider environment --no-passphrase',
    ],
  },
  {
    id: 'vault auth',
    summary: 'Authenticate a vault and cache reusable local auth state.',
    usage: 'cnos vault auth <name> [--store-keychain] [global-options]',
    description:
      'Authenticates an existing local vault using env, keychain, or prompt-based auth and stores a derived session key under ~/.cnos/secrets/sessions for later CNOS commands until logout. With --store-keychain, CNOS also writes the derived key to the OS keychain.',
    examples: ['cnos vault auth local-dev', 'cnos vault auth local-dev --store-keychain'],
  },
  {
    id: 'vault logout',
    summary: 'Clear cached vault auth state.',
    usage: 'cnos vault logout <name> [global-options]',
    description: 'Removes cached vault session auth for the selected vault or all vaults when used with --all. This does not remove any stored OS keychain entry.',
    options: [
      {
        flag: '--all',
        description: 'Clear all cached vault auth sessions from ~/.cnos/secrets/sessions.',
      },
    ],
    examples: ['cnos vault logout local-dev', 'cnos vault logout --all'],
  },
  {
    id: 'vault list',
    summary: 'List manifest-defined vaults.',
    usage: 'cnos vault list [global-options]',
    description:
      'Lists project vault definitions together with provider and passphrase policy. Outside a CNOS project, lists local vault stores from the configured CNOS secret home.',
    examples: ['cnos vault list'],
  },
  {
    id: 'vault remove',
    summary: 'Remove a vault definition.',
    usage: 'cnos vault remove <name> [global-options]',
    description: 'Removes the vault from .cnos/cnos.yml and deletes local vault store metadata when present.',
    examples: ['cnos vault remove local-dev'],
  },
  {
    id: 'var',
    summary: 'Author and operate mutable runtime configuration (var.*) via the control plane.',
    usage:
      'cnos var <create|validate|activate|deactivate|rollback|status|history|replay|serve> <scope> [--store <path> | --server <url>] [options]',
    description:
      'Drives the CNOS var control plane: immutable revisions, monotonic generations, atomic activation, optimistic concurrency, rollback, and an append-only audit log. Local mode (--store <path>) operates directly on a file-backed log; remote mode (--server <url>) targets a running var server. Secrets never appear in var documents (opaque secret.* refs only).',
    options: [
      { flag: '--store <path>', description: 'Local mode: operate directly on a file-backed (JSONL) var log at <path>.' },
      { flag: '--server <url>', description: 'Remote mode: target a running var server base URL (…/cnos/vars).' },
      { flag: '--bearer-token <token>', description: 'Bearer token sent to a remote var server, or required token for serve.' },
      { flag: '--rpc <port>', description: 'serve only: also serve the rpc (gRPC) transport on <port>, sharing the http store/engine.' },
    ],
    examples: [
      'cnos var create agentic.lanes.vinci --document @lane.json --schema agentic-lanes/v1 --store ./.cnos/var-log.jsonl',
      'cnos var activate agentic.lanes.vinci --revision sha256:… --expect-generation 0 --store ./.cnos/var-log.jsonl',
      'cnos var status agentic.lanes.vinci --server https://config.internal/cnos/vars',
      'cnos var serve --store ./.cnos/var-log.jsonl --port 8790 --rpc 8791',
    ],
  },
  {
    id: 'var create',
    summary: 'Create an immutable, validated var revision.',
    usage: 'cnos var create <scope> --document <json|@file> [--schema <schemaId>] [--store <path> | --server <url>] [--actor <a>] [--reason <r>] [--idempotency-key <k>] [global-options]',
    description:
      'Validates a candidate document against its document schema BEFORE storing it. A valid document is stored as a content-addressed revision (sha256); an invalid one is recorded as a rejected audit event and the command fails, leaving the last-known-good head untouched.',
    arguments: [{ name: 'scope', description: 'Var scope key (e.g. agentic.lanes.vinci).', required: true }],
    options: [
      { flag: '--document <json|@file>', description: 'Inline JSON document or @path to a JSON file.' },
      { flag: '--schema <schemaId>', description: 'Document schema id to validate against (from the project manifest documents registry).' },
      { flag: '--idempotency-key <k>', description: 'Client key; a replayed create returns the original result.' },
    ],
    examples: ['cnos var create agentic.lanes.vinci --document @lane.json --schema agentic-lanes/v1 --store ./.cnos/var-log.jsonl'],
  },
  {
    id: 'var validate',
    summary: 'Dry-run validate a candidate var revision.',
    usage: 'cnos var validate [<scope>] --document <json|@file> [--schema <schemaId>] [--store <path> | --server <url>] [global-options]',
    description: 'Validates a document against a document schema without writing anything to the store. Returns { valid, issues }.',
    examples: ['cnos var validate --document @lane.json --schema agentic-lanes/v1 --store ./.cnos/var-log.jsonl'],
  },
  {
    id: 'var activate',
    summary: 'Atomically activate a revision as the new head.',
    usage: 'cnos var activate <scope> --revision <sha256:…> --expect-generation <N> [--store <path> | --server <url>] [--actor <a>] [--reason <r>] [global-options]',
    description:
      'Points the scope head at a created revision, allocating the next monotonic generation. --expect-generation is REQUIRED: a stale value conflicts (revision-conflict) and never overwrites.',
    arguments: [{ name: 'scope', description: 'Var scope key.', required: true }],
    options: [
      { flag: '--revision <sha256:…>', description: 'The created revision to activate.' },
      { flag: '--expect-generation <N>', description: 'Required optimistic-concurrency guard; must equal the current generation.' },
    ],
    examples: ['cnos var activate agentic.lanes.vinci --revision sha256:… --expect-generation 0 --store ./.cnos/var-log.jsonl'],
  },
  {
    id: 'var deactivate',
    summary: 'Remove the runtime head so consumers fall back to static/default.',
    usage: 'cnos var deactivate <scope> --expect-generation <N> [--store <path> | --server <url>] [global-options]',
    description: 'Removes the active head as a new generation. Consumers cleanly fall back to static value.* / schema defaults with no deployment.',
    arguments: [{ name: 'scope', description: 'Var scope key.', required: true }],
    options: [{ flag: '--expect-generation <N>', description: 'Required optimistic-concurrency guard.' }],
    examples: ['cnos var deactivate agentic.lanes.vinci --expect-generation 3 --store ./.cnos/var-log.jsonl'],
  },
  {
    id: 'var rollback',
    summary: 'Re-activate a prior revision as a new generation.',
    usage: 'cnos var rollback <scope> --expect-generation <N> [--to-revision <sha256:…> | --to-generation <N>] [--store <path> | --server <url>] [global-options]',
    description: 'Activates a prior revision as a NEW generation (history is append-only). Target it by revision or by a past generation; audited like any activation.',
    arguments: [{ name: 'scope', description: 'Var scope key.', required: true }],
    options: [
      { flag: '--to-revision <sha256:…>', description: 'Prior revision to re-activate.' },
      { flag: '--to-generation <N>', description: 'Prior generation whose revision to re-activate.' },
      { flag: '--expect-generation <N>', description: 'Required optimistic-concurrency guard.' },
    ],
    examples: ['cnos var rollback agentic.lanes.vinci --to-generation 2 --expect-generation 4 --store ./.cnos/var-log.jsonl'],
  },
  {
    id: 'var status',
    summary: 'Show the current head/generation/rejection status for a scope.',
    usage: 'cnos var status <scope> [--store <path> | --server <url>] [--json] [global-options]',
    description: 'Reports active generation, current revision, source, and the last rejected revision. Never exposes secret material.',
    arguments: [{ name: 'scope', description: 'Var scope key.', required: true }],
    examples: ['cnos var status agentic.lanes.vinci --server https://config.internal/cnos/vars --json'],
  },
  {
    id: 'var history',
    summary: 'Show the append-only audit log for a scope.',
    usage: 'cnos var history <scope> [--store <path> | --server <url>] [--json] [global-options]',
    description: 'Lists every revision-created / activated / deactivated / rejected event for the scope, in order. Secret material never appears in the log.',
    arguments: [{ name: 'scope', description: 'Var scope key.', required: true }],
    examples: ['cnos var history agentic.lanes.vinci --store ./.cnos/var-log.jsonl --json'],
  },
  {
    id: 'var replay',
    summary: 'Reconstruct scope state at a past generation (persistent stores only).',
    usage: 'cnos var replay <scope> --to-generation <N> --store <path> [--json] [global-options]',
    description: 'Folds the log up to generation N and returns the head that was active then. Requires a persistent (file-backed) store.',
    arguments: [{ name: 'scope', description: 'Var scope key.', required: true }],
    options: [{ flag: '--to-generation <N>', description: 'Generation to reconstruct.' }],
    examples: ['cnos var replay agentic.lanes.vinci --to-generation 2 --store ./.cnos/var-log.jsonl'],
  },
  {
    id: 'var serve',
    summary: 'Run a standalone var server (thin wrapper over the embeddable library).',
    usage: 'cnos var serve [--store <path>] [--host <h>] [--port <n>] [--bearer-token <token>] [global-options]',
    description:
      'Starts an HTTP var server. With --store it is file-backed and durable; without, it uses an ephemeral memory store. Document schemas are loaded from the project manifest. Runs until SIGINT/SIGTERM.',
    options: [
      { flag: '--store <path>', description: 'File-backed durable log path. Omit for an ephemeral memory store.' },
      { flag: '--host <h>', description: 'Bind host (default 127.0.0.1).' },
      { flag: '--port <n>', description: 'Bind port (default random free port).' },
      { flag: '--bearer-token <token>', description: 'Require this bearer token for all requests (static dev auth).' },
    ],
    examples: ['cnos var serve --store ./.cnos/var-log.jsonl --port 8790'],
  },
  {
    id: 'define',
    summary: 'Write a value or secret into the selected workspace.',
    usage: 'cnos define <value|secret> <path> <rawValue> [--target <local|global>] [global-options]',
    description:
      'Writes deterministic YAML into the selected workspace. Secret writes default to secure local-secret storage plus a repo ref. Global writes require allowWrite and an explicit --target global flag.',
    arguments: [
      {
        name: 'namespace',
        description: 'Either value or secret.',
        required: true,
      },
      {
        name: 'path',
        description: 'Path without the namespace prefix.',
        required: true,
      },
      {
        name: 'rawValue',
        description: 'Literal value to write.',
        required: true,
      },
    ],
    options: [
      {
        flag: '--target <local|global>',
        description: 'Choose whether the write lands in the local project workspace or the configured global root.',
      },
    ],
    examples: [
      'cnos define value server.port 3000 --workspace api',
      'cnos define secret app.token super-secret --workspace api',
    ],
  },
  {
    id: 'spec',
    summary: 'Author and inspect manifest-global config specs stored under schema.',
    usage: 'cnos spec [list | show <logicalKey> | set <logicalKey> | delete <logicalKey> | doctor] [options] [global-options]',
    description:
      'Manages CNOS config specs (user-facing "spec") stored in the manifest schema: block. Use cnos define/value/secret for concrete value authoring.',
    examples: [
      'cnos spec list',
      'cnos spec show value.server.port',
      'cnos spec set value.server.port --type number --required --summary "HTTP server port"',
      'cnos spec delete value.legacy.flag',
      'cnos spec doctor',
    ],
  },
  {
    id: 'spec list',
    summary: 'List declared spec entries.',
    usage: 'cnos spec list [--prefix <path>] [global-options]',
    description: 'Lists manifest schema entries. In v1, spec entries are manifest-global rather than workspace-scoped.',
    options: [
      {
        flag: '--prefix <path>',
        description: 'Filter listed spec keys by logical-key prefix.',
      },
    ],
    examples: ['cnos spec list', 'cnos spec list --prefix value.server.'],
  },
  {
    id: 'spec show',
    summary: 'Show one spec entry.',
    usage: 'cnos spec show <logicalKey> [global-options]',
    description: 'Shows one manifest schema entry by namespace-qualified logical key.',
    arguments: [
      {
        name: 'logicalKey',
        description: 'Namespace-qualified key such as value.server.port.',
        required: true,
      },
    ],
    examples: ['cnos spec show value.server.port', 'cnos spec show secret.db.password --json'],
  },
  {
    id: 'spec set',
    summary: 'Create or update one spec entry.',
    usage: 'cnos spec set <logicalKey> [field-flags] [global-options]',
    description:
      'Writes one manifest schema entry. With no field flags in a TTY, CNOS enters interactive authoring mode. With field flags, CNOS uses non-interactive mode.',
    arguments: [
      {
        name: 'logicalKey',
        description: 'Namespace-qualified key such as value.server.port.',
        required: true,
      },
    ],
    options: [
      {
        flag: '--type <string|number|boolean|object|array>',
        description: 'Set expected value type.',
      },
      {
        flag: '--required | --optional',
        description: 'Mark key required or optional.',
      },
      {
        flag: '--default <jsonOrScalar>',
        description: 'Set default using JSON-first parsing; fallback is literal string.',
      },
      {
        flag: '--enum <jsonArray>',
        description: 'Set allowed values from a non-empty JSON array.',
      },
      {
        flag: '--pattern <regex>',
        description: 'Set regex pattern for string values.',
      },
      {
        flag: '--summary <text>',
        description: 'Set short description.',
      },
      {
        flag: '--description <text>',
        description: 'Set long description.',
      },
      {
        flag: '--example <value>',
        description: 'Add example value. Repeatable. JSON-first parsing.',
      },
      {
        flag: '--used-by <text>',
        description: 'Add usage context text. Repeatable.',
      },
      {
        flag: '--deprecated',
        description: 'Mark as deprecated.',
      },
      {
        flag: '--deprecation-message <text>',
        description: 'Set deprecation message and auto-mark deprecated.',
      },
      {
        flag: '--clear-default | --clear-enum | --clear-pattern | --clear-summary | --clear-description | --clear-examples | --clear-used-by | --clear-deprecated | --clear-deprecation-message',
        description: 'Explicitly clear stored fields.',
      },
    ],
    examples: [
      'cnos spec set value.server.port --type number --required --summary "HTTP server port"',
      'cnos spec set value.app.stage --enum \'["local","stage","prod"]\'',
      'cnos spec set value.legacy.flag --clear-deprecated',
    ],
  },
  {
    id: 'spec delete',
    summary: 'Delete one spec entry.',
    usage: 'cnos spec delete <logicalKey> [global-options]',
    description: 'Removes one manifest schema entry by namespace-qualified logical key.',
    arguments: [
      {
        name: 'logicalKey',
        description: 'Namespace-qualified key such as value.server.port.',
        required: true,
      },
    ],
    examples: ['cnos spec delete value.legacy.flag', 'cnos spec remove value.legacy.flag --json'],
  },
  {
    id: 'spec doctor',
    summary: 'Compare declared spec against current config and guide remediation.',
    usage: 'cnos spec doctor [--fill-missing|--review-all] [global-options]',
    description:
      'Report mode shows missing required keys, undeclared keys, type/enum/pattern mismatches, defaults in use, and deprecated keys in use. Write modes run interactive remediation flows.',
    options: [
      {
        flag: '--fill-missing',
        description: 'Interactively fill only missing required keys. Requires TTY and writable root.',
      },
      {
        flag: '--review-all',
        description: 'Interactively review all declared spec keys one by one. Requires TTY and writable root.',
      },
    ],
    examples: [
      'cnos spec doctor',
      'cnos spec doctor --json',
      'cnos spec doctor --fill-missing',
      'cnos spec doctor --review-all --workspace api --profile stage',
    ],
  },
  {
    id: 'use',
    summary: 'Persist repo-local CLI defaults such as workspace and profile.',
    usage: 'cnos use [show] [--workspace <id>] [--profile <name>] [--global-root <path>] [--root <path>] [--json]',
    description:
      'Shows the current repo-local CLI context by default, or writes .cnos-workspace.yml when workspace/profile/global-root flags are provided.',
    examples: ['cnos use show', 'cnos use --workspace api --profile stage', 'cnos use --global-root ~/.cnos'],
  },
  {
    id: 'list',
    summary: 'List resolved config entries.',
    usage: 'cnos list [<namespace>|all] [--prefix <path>] [--framework <name>] [global-options]',
    description:
      'Lists stored config or derived projections across one namespace or the full effective graph, with optional prefix filtering. Derived values are annotated with `(derived)`. Custom data namespaces such as flags are supported, and process exposes server-only ambient runtime state.',
    options: [
      {
        flag: '--namespace <name>',
        description: 'Explicit namespace selector when not using a positional namespace argument.',
      },
      {
        flag: '--prefix <path>',
        description: 'Filter list output to entries whose logical keys begin with this prefix.',
      },
      {
        flag: '--framework <name>',
        description: 'When listing public output, apply framework-specific prefixes such as vite or next.',
      },
    ],
    examples: ['cnos list', 'cnos list value --prefix app.', 'cnos list flags', 'cnos list process --prefix env.PATH', 'cnos list env', 'cnos list public --framework vite'],
  },
  {
    id: 'profile',
    summary: 'Manage CNOS profiles.',
    usage: 'cnos profile [create <name> | list | use <name> | delete <name>] [options] [global-options]',
    description:
      'Creates and lists explicit profiles and stores the active repo-local profile selection for CLI usage.',
    options: [
      {
        flag: '--inherit <name>',
        description: 'Parent profile to extend when creating a profile. Base inheritance is implicit by default.',
      },
      {
        flag: '--no-inherit',
        description: 'Create a clean profile that does not inherit base fallback layers.',
      },
      {
        flag: '--private | --incog | --anonymous',
        description:
          'Store the profile in .cnos/.private so generated values and secret references stay out of committed .cnos trees.',
      },
    ],
    examples: [
      'cnos profile create stage',
      'cnos profile create isolated --no-inherit',
      'cnos profile create private-stage --private',
      'cnos profile list',
      'cnos profile use stage',
    ],
  },
  {
    id: 'profile create',
    summary: 'Create a profile definition.',
    usage:
      'cnos profile create <name> [--inherit <name> | --no-inherit] [--private|--incog|--anonymous] [--root <path>] [--json]',
    description:
      'Creates .cnos/profiles/<name>.yml for an explicit profile overlay. New profiles inherit base by default unless --no-inherit is set.',
    options: [
      {
        flag: '--private | --incog | --anonymous',
        description:
          'Store the profile in .cnos/.private so generated values and secret references stay out of committed .cnos trees.',
      },
    ],
    examples: [
      'cnos profile create stage',
      'cnos profile create isolated --no-inherit',
      'cnos profile create private-stage --private',
    ],
  },
  {
    id: 'profile list',
    summary: 'List available profiles.',
    usage: 'cnos profile list [--root <path>] [--json]',
    description: 'Lists the base profile plus any explicit profile definition files in .cnos/profiles.',
    examples: ['cnos profile list'],
  },
  {
    id: 'profile use',
    summary: 'Persist the active profile for this repo.',
    usage: 'cnos profile use <name> [--root <path>] [--json]',
    description: 'Writes the selected profile into .cnos-workspace.yml.',
    examples: ['cnos profile use stage'],
  },
  {
    id: 'profile delete',
    summary: 'Delete a profile definition.',
    usage: 'cnos profile delete <name> [--root <path>] [--json]',
    description: 'Deletes .cnos/profiles/<name>.yml.',
    examples: ['cnos profile delete stage'],
  },
  {
    id: 'promote',
    summary: 'Promote shareable config into public or env projection surfaces.',
    usage: 'cnos promote <key...> --to <public|env> [--as <ENV_VAR>] [--allow-secret] [global-options]',
    description:
      'Adds keys to public.promote or envMapping.explicit in .cnos/cnos.yml. Sensitive or non-shareable namespaces are rejected by default, but secret.* may be mapped to env explicitly when you pass --allow-secret. public never allows secret promotion.',
    options: [
      {
        flag: '--to <public|env>',
        description: 'Choose whether the keys are promoted to the public surface or env export surface.',
      },
      {
        flag: '--as <ENV_VAR>',
        description: 'Required for --to env. Sets the exported env var name for the promoted key.',
      },
      {
        flag: '--allow-secret',
        description: 'Allow secret.* only for --to env. This does not permit secret promotion to public.',
      },
    ],
    examples: [
      'cnos promote value.flag.auth.upi_enabled --to public',
      'cnos promote flags.upi_enabled --to public',
      'cnos promote value.server.port --to env --as PORT',
      'cnos promote secret.db.password --to env --as POSTGRES_PASSWORD --allow-secret',
    ],
  },
  {
    id: 'secret set',
    summary: 'Write a secret securely.',
    usage: 'cnos secret set <path> [value] [--local|--remote|--ref] [--vault <name>] [--provider <name>] [--stdin] [global-options]',
    description:
      'Writes a secret reference into the repo. When a local vault is selected, CNOS stores encrypted secret material outside the repo under ~/.cnos/secrets/vaults/<vault>; when a non-local vault is selected, CNOS writes reference metadata only and never prompts for secret material by default. If [value] is omitted for a non-local vault, the logical path is used as the external ref.',
    examples: [
      'cnos vault create db',
      'cnos vault auth db',
      'cnos secret set app.token super-secret --vault db',
      'cnos secret set app.token --vault db',
      'printf "super-secret" | cnos secret set app.token --vault db --stdin',
      'cnos vault create github-ci --provider environment --no-passphrase',
      'cnos secret set app.token APP_TOKEN --vault github-ci',
      'cnos secret set app.token --vault prod-gcp',
    ],
  },
  {
    id: 'secret create vault',
    summary: 'Create a local secret vault.',
    usage: 'cnos secret create vault <name> [global-options]',
    description: 'Alias for cnos vault create <name>.',
    examples: ['cnos secret create vault db'],
  },
  {
    id: 'secret list',
    summary: 'List resolved secrets.',
    usage: 'cnos secret list [--vault <name>] [--provider <name>] [--reveal] [global-options]',
    description:
      'Lists secret keys for the selected workspace and profile as masked values by default, or as resolved values when --reveal is supplied. Supports optional vault and provider filtering.',
    examples: [
      'cnos secret list --workspace api',
      'cnos secret list --vault github-ci',
      'cnos secret list --workspace api --reveal',
    ],
  },
  {
    id: 'secret delete',
    summary: 'Delete a secret reference.',
    usage: 'cnos secret delete <path> [--target <local|global>] [global-options]',
    description:
      'Deletes the secret reference from the repo and removes local encrypted material when the secret used the local provider.',
    examples: ['cnos secret delete app.token'],
  },
  {
    id: 'inspect',
    summary: 'Inspect the winning value and provenance for a key.',
    usage: 'cnos inspect <key> [global-options]',
    description:
      'Shows the resolved value, namespace, active profile, workspace context, loader/origin, and derived-expression metadata when the key is computed from other CNOS keys or runtime namespaces.',
    arguments: [
      {
        name: 'key',
        description: 'Fully-qualified key to inspect.',
        required: true,
      },
    ],
    examples: ['cnos inspect value.server.port', 'cnos inspect secret.app.token --workspace api --json'],
  },
  {
    id: 'validate',
    summary: 'Validate schema, public promotion, and workspace safety rules.',
    usage: 'cnos validate [global-options]',
    description:
      'Runs the CNOS validation pipeline and exits non-zero when validation issues are found.',
    examples: ['cnos validate', 'cnos validate --workspace api --profile stage --json'],
  },
  {
    id: 'export',
    summary: 'Export data from the selected workspace.',
    usage: 'cnos export <subcommand> [options] [global-options]',
    description: 'Currently supports env export for runtime and public environment projections.',
    arguments: [
      {
        name: 'subcommand',
        description: 'Supported value: env.',
        required: true,
      },
    ],
    examples: [
      'cnos export env',
      'cnos export env --public --framework vite --workspace api',
      'cnos export env --public --framework next --workspace webapp',
    ],
  },
  {
    id: 'build',
    summary: 'Build derived configuration artifacts from CNOS.',
    usage: 'cnos build <subcommand> [options] [global-options]',
    description: 'Builds deterministic derived outputs from the selected workspace, including server projections, browser projections, env files, and framework-prefixed public env.',
    arguments: [
      {
        name: 'subcommand',
        description: 'Supported values: server, browser, env, public.',
        required: true,
      },
    ],
    examples: [
      'cnos build server --to .cnos-server.json',
      'cnos build browser --to .cnos-browser.json',
      'cnos build env --profile local --to .env.local',
      'cnos build public --framework vite --profile prod --to .env.production',
    ],
  },
  {
    id: 'build server',
    summary: 'Build a server runtime projection artifact.',
    usage: 'cnos build server --to <path> [--format <json|yaml>] [--dynamic] [global-options]',
    description:
      'Builds a flat server projection for runtime auto-loading. Non-secret values are embedded, while secret refs remain refs and hydrate at runtime. ' +
      'Pass --dynamic to include all schema-declared keys in the overrides block even when they have no stored value, ' +
      'so runtimes can apply schema type metadata to values supplied via --cnos-patch at startup.',
    examples: [
      'cnos build server --to .cnos-server.json',
      'cnos build server --profile prod --to dist/.cnos-server.json',
      'cnos build server --dynamic --to .cnos-server.json',
    ],
  },
  {
    id: 'build browser',
    summary: 'Build a browser projection artifact.',
    usage: 'cnos build browser --to <path> [--format <json|yaml>] [global-options]',
    description:
      'Builds a public-only browser projection for tooling and offline packaging flows. secret.* keys are excluded entirely.',
    examples: ['cnos build browser --to .cnos-browser.json'],
  },
  {
    id: 'build env',
    summary: 'Build a flat env-file artifact from CNOS.',
    usage: 'cnos build env --to <path> [--format <dotenv|docker-env|json|shell|toml|yaml>] [--reveal] [global-options]',
    description:
      'Builds a deterministic KEY=VALUE artifact for legacy build and runtime workflows. Secret env mappings stay masked by default; use --reveal only when the target env file is gitignored and you intentionally want concrete secret values. CNOS prints explicit risk warnings before revealed secret writes.',
    options: [
      {
        flag: '--to <path>',
        description: 'Write the rendered KEY=VALUE output to a file. Required.',
      },
      {
        flag: '--format <dotenv|docker-env|json|shell|toml|yaml>',
        description: 'Select the output format. Defaults to dotenv.',
      },
      {
        flag: '--reveal',
        description: 'Write concrete values for secret env mappings after gitignore verification and an interactive warning prompt.',
      },
    ],
    examples: [
      'cnos build env --profile local --to .env.local',
      'cnos build env --profile stage --to .env.stage',
      'cnos build env --profile prod --reveal --to .env.production.local',
      'cnos build env --profile prod --format yaml --to env.yaml',
    ],
  },
  {
    id: 'build public',
    summary: 'Build a public env artifact with optional framework prefixing.',
    usage: 'cnos build public --to <path> [--framework <name>] [--format <dotenv|docker-env|json|shell|toml|yaml>] [global-options]',
    description:
      'Builds env-style public artifacts from promoted keys only, with framework-specific prefixes such as vite or next when requested.',
    examples: ['cnos build public --framework vite --to .env.vite', 'cnos build public --framework next --format json --to public.json'],
  },
  {
    id: 'export env',
    summary: 'Render environment variables for the selected workspace.',
    usage: 'cnos export env [--public] [--framework <name>] [--prefix <prefix>] [--to <path>] [global-options]',
    description:
      'Exports the effective environment as KEY=VALUE lines, or only promoted public values when --public is set.',
    options: [
      {
        flag: '--public',
        description: 'Export only public values based on manifest promotion rules.',
      },
      {
        flag: '--framework <name>',
        description: 'Apply framework-specific public env conventions such as vite, next, or nuxt.',
      },
      {
        flag: '--prefix <prefix>',
        description: 'Override the generated public env prefix.',
      },
      {
        flag: '--to <path>',
        description: 'Write the rendered KEY=VALUE output to a file instead of stdout.',
      },
    ],
    examples: [
      'cnos export env',
      'cnos export env --to .env.local',
      'cnos export env --public --framework vite --to .env.local --workspace api',
    ],
  },
  {
    id: 'dev',
    summary: 'Run watched CNOS-driven development workflows.',
    usage: 'cnos dev <subcommand> [options] [global-options] -- <command...>',
    description:
      'Runs higher-level development workflows that derive config artifacts from CNOS and keep them up to date while a child process is running.',
    arguments: [
      {
        name: 'subcommand',
        description: 'Supported value: env.',
        required: true,
      },
    ],
    examples: [
      'cnos dev env --profile local --to .env.local -- pnpm dev',
      'cnos dev env --public --framework vite --to .env.local -- pnpm dev',
    ],
  },
  {
    id: 'dev env',
    summary: 'Watch CNOS config, rewrite an env file, and restart a child process.',
    usage: 'cnos dev env --to <path> [--public] [--framework <name>] [--prefix <prefix>] [--debounce <ms>] [--signal] [global-options] -- <command...>',
    description:
      'Writes a derived env file before first launch, watches CNOS inputs, rewrites the file on change, and restarts the child process by default.',
    options: [
      {
        flag: '--to <path>',
        description: 'Write the rendered KEY=VALUE output to a file. Required.',
      },
      {
        flag: '--public',
        description: 'Build only public values based on manifest promotion rules.',
      },
      {
        flag: '--framework <name>',
        description: 'Apply framework-specific public env conventions such as vite or next.',
      },
      {
        flag: '--prefix <prefix>',
        description: 'Override the generated public env prefix.',
      },
      {
        flag: '--debounce <ms>',
        description: 'Debounce config changes before rebuilding the env artifact. Defaults to 300ms.',
      },
      {
        flag: '--signal',
        description: 'Rewrite the env artifact and emit changed keys as JSON instead of restarting the child process.',
      },
    ],
    examples: [
      'cnos dev env --profile local --to .env.local -- pnpm dev',
      'cnos dev env --profile stage --to .env.stage -- node server.js',
      'cnos dev env --public --framework vite --to .env.local --signal -- pnpm dev',
    ],
  },
  {
    id: 'dump',
    summary: 'Materialize the selected workspace into files.',
    usage: 'cnos dump --to <path> [--flatten] [global-options]',
    description:
      'Writes the effective workspace snapshot to disk. Use --flatten to emit a standalone values/secrets tree instead of preserving workspace layout.',
    options: [
      {
        flag: '--to <path>',
        description: 'Destination directory for the materialized snapshot.',
      },
      {
        flag: '--flatten',
        description: 'Write a flattened values/secrets tree instead of workspace-preserving output.',
      },
    ],
    examples: ['cnos dump --to ./out', 'cnos dump --to ./snapshot --flatten --workspace api'],
  },
  {
    id: 'run',
    summary: 'Run a child process with CNOS env injected.',
    usage: 'cnos run [--public] [--auth] [--framework <name>] [--set <logical-key=value>] [global-options] -- <command...>',
    description:
      'Resolves the active workspace and profile, injects runtime env variables, includes explicit secret env mappings for private runs, bootstraps __CNOS_GRAPH__ for singleton runtime reads, and executes the command after --.',
    options: [
      {
        flag: '--set <logical-key=value>',
        description: 'Apply inline logical-key overrides for this run without touching repo config files.',
      },
      {
        flag: '--auth',
        description: 'Resolve secrets eagerly and pass an encrypted secret payload to bootstrapped CNOS runtimes in the child process.',
      },
      {
        flag: '--public',
        description: 'Inject only promoted public env variables into the child process.',
      },
      {
        flag: '--framework <name>',
        description: 'When used with --public, apply framework-specific prefixes such as vite or next.',
      },
      {
        flag: '--prefix <prefix>',
        description: 'Override the generated public env prefix for --public runs.',
      },
    ],
    examples: [
      'cnos run -- node server.js',
      'cnos run --profile stage -- node server.js',
      'cnos run --auth -- node server.js',
      'cnos run --set value.server.port=9999 -- node server.js',
      'cnos run --public --framework vite -- pnpm build',
    ],
  },
  {
    id: 'workspace',
    summary: 'Manage workspace creation, listing, migration, and attach/detach flows.',
    usage: 'cnos workspace <enable|add|list|remove|scaffold|attach|detach> [options] [global-options]',
    description:
      'Enables workspace mode for flat CNOS projects, adds and removes manifest workspaces, scaffolds package anchors, and handles detach/attach flows for independent child packages.',
    examples: [
      'cnos workspace list',
      'cnos workspace enable',
      'cnos workspace add travel --package-root apps/travel --extends base',
      'cnos workspace remove gallery',
      'cnos workspace detach --package-root apps/travel',
    ],
  },
  {
    id: 'workspace enable',
    summary: 'Convert a flat regular-mode CNOS root into workspace mode with base.',
    usage: 'cnos workspace enable [global-options]',
    description:
      'Moves .cnos/values, .cnos/secrets, .cnos/env, and .cnos/profiles into .cnos/workspaces/base, adds a workspaces block to cnos.yml, and updates the root anchor to workspace: base.',
    examples: ['cnos workspace enable'],
  },
  {
    id: 'workspace add',
    summary: 'Add a child workspace to the manifest and scaffold its on-disk layout.',
    usage: 'cnos workspace add <id> [--package-root <path>] [--extends <workspace|none>] [--force] [global-options]',
    description:
      'Creates .cnos/workspaces/<id>, updates cnos.yml, and writes a .cnosrc.yml anchor at the selected package root. When a base workspace exists, CNOS defaults new child workspaces to extends: [base] unless --extends or --extends none is provided.',
    examples: [
      'cnos workspace add travel --package-root apps/travel --extends base',
      'cnos workspace add insights --package-root apps/insights',
      'cnos workspace add api --extends none',
    ],
  },
  {
    id: 'workspace scaffold',
    summary: 'Scaffold a workspace and anchor without changing other runtime flows.',
    usage: 'cnos workspace scaffold <id> [--package-root <path>] [--extends <workspace>] [--force] [global-options]',
    description:
      'Creates the workspace manifest entry, workspace folders, and package anchor for a new app or package. This is an alias-oriented workflow for teams that prefer scaffold wording over add.',
    examples: ['cnos workspace scaffold gallery --package-root apps/gallery --extends base'],
  },
  {
    id: 'workspace list',
    summary: 'List declared workspaces and their inheritance.',
    usage: 'cnos workspace list [global-options]',
    description:
      'Shows the declared workspace ids, default workspace, and extends relationships from cnos.yml.',
    examples: ['cnos workspace list', 'cnos workspace list --json'],
  },
  {
    id: 'workspace remove',
    summary: 'Remove a workspace from the manifest and delete its local workspace tree.',
    usage: 'cnos workspace remove <id> [global-options]',
    description:
      'Deletes .cnos/workspaces/<id> and removes the workspace entry from cnos.yml. CNOS refuses to remove the current default workspace until you change workspaces.default.',
    examples: ['cnos workspace remove gallery', 'cnos workspace remove insights --json'],
  },
  {
    id: 'workspace detach',
    summary: 'Detach a package workspace into a standalone .cnos root.',
    usage: 'cnos workspace detach [--package-root <path>] [--force] [global-options]',
    description:
      'Materializes the effective local workspace chain into a package-local .cnos directory, rewrites .cnosrc.yml to root: ./.cnos, and records the original parent binding in .cnos/.detached.',
    examples: ['cnos workspace detach', 'cnos workspace detach --package-root apps/travel --force'],
  },
  {
    id: 'workspace attach',
    summary: 'Attach a detached package back to its original parent CNOS root.',
    usage: 'cnos workspace attach [--package-root <path>] [--force] [global-options]',
    description:
      'Imports a detached package-local .cnos directory back into the original parent workspace, archives the detached snapshot, and restores .cnosrc.yml to the parent root/workspace binding.',
    examples: ['cnos workspace attach', 'cnos workspace attach --package-root apps/travel --force'],
  },
  {
    id: 'diff',
    summary: 'Diff two profiles for the same workspace.',
    usage: 'cnos diff <leftProfile> <rightProfile> [global-options]',
    description:
      'Compares effective value and secret graphs between two profiles in the selected workspace.',
    arguments: [
      {
        name: 'leftProfile',
        description: 'Baseline profile name.',
        required: true,
      },
      {
        name: 'rightProfile',
        description: 'Comparison profile name.',
        required: true,
      },
    ],
    examples: ['cnos diff local stage --workspace api', 'cnos diff stage prod --workspace api --json'],
  },
  {
    id: 'doctor',
    summary: 'Run repository and workspace diagnostics.',
    usage: 'cnos doctor [--fix-secret-env-mappings] [global-options]',
    description:
      'Checks manifest/workspace setup, gitignore coverage, and related diagnostics for the selected workspace. Secret env mappings are reported as a security risk; use --fix-secret-env-mappings to remove them from envMapping.explicit in one shot. When schema entries exist, doctor points to cnos spec doctor for spec coverage and remediation.',
    examples: ['cnos doctor', 'cnos doctor --workspace api --json', 'cnos doctor --fix-secret-env-mappings'],
  },
  {
    id: 'drift',
    summary: 'Compare resolved config against schema and report drift.',
    usage: 'cnos drift [--workspace <id>] [--profile <name>] [--json]',
    description:
      'Reports missing required keys, undeclared keys, type mismatches, and defaults applied for the selected workspace/profile.',
    examples: ['cnos drift', 'cnos drift --workspace api --profile stage', 'cnos drift --json'],
  },
  {
    id: 'watch',
    summary: 'Watch CNOS inputs and either restart a process or emit changed keys.',
    usage: 'cnos watch [--signal] [--debounce <ms>] [global-options] -- <command...>',
    description:
      'Watches the active manifest, workspace roots, env files, and config documents. In restart mode it respawns the child command after changes; in signal mode it prints changed keys as JSON.',
    options: [
      {
        flag: '--signal',
        description: 'Emit changed keys as JSON instead of restarting a child process.',
      },
      {
        flag: '--debounce <ms>',
        description: 'Debounce change handling before re-resolving the graph. Defaults to 300ms.',
      },
    ],
    examples: ['cnos watch -- node server.js', 'cnos watch --signal', 'cnos watch --debounce 100 -- node server.js'],
  },
  {
    id: 'migrate',
    summary: 'Scan env usage and propose CNOS manifest mappings.',
    usage: 'cnos migrate [--scan <path>] [--dry-run] [--apply] [--rewrite] [global-options]',
    description:
      'Scans JS/TS source for process.env and import.meta.env usage, proposes logical CNOS mappings, updates envMapping/public promote entries, and can rewrite supported source files with backups.',
    options: [
      {
        flag: '--scan <path>',
        description: 'Directory to scan. Defaults to ./src relative to the repo root.',
      },
      {
        flag: '--dry-run',
        description: 'Preview the proposed mappings without changing the manifest.',
      },
      {
        flag: '--apply',
        description: 'Write proposed env mappings and public promotions into .cnos/cnos.yml.',
      },
      {
        flag: '--rewrite',
        description: 'With --apply, rewrite supported process.env usages in source files and create .bak backups.',
      },
    ],
    examples: [
      'cnos migrate',
      'cnos migrate --scan src --dry-run',
      'cnos migrate --scan apps/api/src --apply',
      'cnos migrate --apply --rewrite',
    ],
  },
  {
    id: 'help',
    summary: 'Show human-readable CLI help.',
    usage: 'cnos help [command]',
    description: 'Prints either the root command list or detailed help for a specific command.',
    arguments: [
      {
        name: 'command',
        description: 'Optional command or subcommand, for example export env.',
      },
    ],
    examples: ['cnos help', 'cnos help define', 'cnos help export env'],
  },
  {
    id: 'help-ai',
    summary: 'Show machine-readable CLI help for agents.',
    usage: 'cnos help-ai [command] [--format <json|text>]',
    description:
      'Prints structured CLI help intended for automation and agents. JSON is the default format.',
    arguments: [
      {
        name: 'command',
        description: 'Optional command or subcommand, for example export env.',
      },
    ],
    options: [
      {
        flag: '--format <json|text>',
        description: 'Select output format. Defaults to json.',
      },
    ],
    examples: ['cnos help-ai --format json', 'cnos help-ai export env --format json'],
  },
  {
    id: 'ui',
    summary: 'Launch the CNOS local UI.',
    usage: 'cnos ui [--host <host>] [--port <port>] [--api-port <port>] [global-options]',
    description:
      'Starts a local CNOS API server plus the Vite-powered React UI for browsing values, env mappings, public config, and inspect data.',
    options: [
      {
        flag: '--host <host>',
        description: 'Host for the UI dev server. Defaults to 127.0.0.1.',
      },
      {
        flag: '--port <port>',
        description: 'Port for the UI dev server. Defaults to 4310.',
      },
      {
        flag: '--api-port <port>',
        description: 'Port for the backing CNOS API server. Defaults to 4311.',
      },
    ],
    examples: ['cnos ui', 'cnos ui --port 4400 --api-port 4401'],
  },
  {
    id: 'version',
    summary: 'Print the installed CNOS CLI version.',
    usage: 'cnos version',
    description: 'Prints the installed @kitsy/cnos-cli version string.',
    examples: ['cnos version', 'cnos --version'],
  },
];

const INTEGRATIONS: HelpIntegration[] = [
  {
    id: 'vite',
    packageName: '@kitsy/cnos-vite',
    entrypoint: '@kitsy/cnos-vite',
    summary: 'Inject CNOS public env into Vite and embed browser-readable CNOS public data.',
    usage: 'import { createCnosVitePlugin } from "@kitsy/cnos-vite"',
    examples: [
      'cnos export env --public --framework vite',
      'vite.config.ts -> plugins: [createCnosVitePlugin()]',
      'browser code -> import cnos from "@kitsy/cnos/browser"',
    ],
  },
  {
    id: 'next',
    packageName: '@kitsy/cnos-next',
    entrypoint: '@kitsy/cnos-next',
    summary: 'Merge CNOS public env into Next and embed browser-readable CNOS public data.',
    usage: 'import { withCnosNext } from "@kitsy/cnos-next"',
    examples: [
      'cnos export env --public --framework next',
      'next.config.mjs -> export default withCnosNext({})',
      'browser code -> import cnos from "@kitsy/cnos/browser"',
    ],
  },
];

export const HELP_DOCUMENT: HelpDocument = {
  name: 'cnos',
  summary: 'Workspace-aware configuration runtime and CLI for local, global, and promoted environment data.',
  usage: 'cnos <command> [args] [options]',
  description:
    'CNOS resolves one active workspace per invocation, layers local and optional global config roots, and exposes read, write, export, dump, validation, and diagnostics commands.',
  globalOptions: GLOBAL_OPTIONS,
  commands: COMMANDS,
  integrations: INTEGRATIONS,
  examples: [
    'cnos use --profile stage',
    'cnos doctor --workspace api',
    'cnos cache list',
    'cnos build env --profile stage --to .env.stage',
    'cnos dev env --profile local --to .env.local -- pnpm dev',
    'cnos export env --public --framework vite',
    'cnos export env --public --framework next',
    'cnos help-ai --format json',
  ],
  runtimeFlags: [
    {
      flag: '--cnos-patch=<path>',
      description:
        'Load a bulk patch file at application startup. Supported formats: JSON (.json), YAML (.yaml/.yml, Node.js only), and Java-style properties (.properties, .env). ' +
        'Keys must be full logical CNOS keys (e.g. "value.server.port", "secret.db.password"). ' +
        'Priority: OverrideSpec(arg) > OverrideSpec(env) > patch file > CNOS resolved value. ' +
        'Empty or type-mismatched values emit a warning to stderr and fall through to the next source. ' +
        'Env-var alternative: CNOS_PATCH_FILE=<path>. ' +
        'Supported in all 8 runtimes (JSON + properties) and additionally YAML in the Node.js runtime.',
    },
  ],
};

export function normalizeHelpTopic(parts: string[]): string | undefined {
  const cleaned = parts.filter((part) => part.length > 0);

  if (cleaned.length === 0) {
    return undefined;
  }

  const candidate = cleaned.join(' ');

  if (COMMANDS.some((command) => command.id === candidate)) {
    return candidate;
  }

  throw new Error(`Unknown help topic: ${candidate}`);
}

export function findHelpCommand(topic: string | undefined): HelpCommand | undefined {
  if (!topic) {
    return undefined;
  }

  return COMMANDS.find((command) => command.id === topic);
}
