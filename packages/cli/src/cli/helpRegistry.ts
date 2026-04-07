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
}

const GLOBAL_OPTIONS: HelpOption[] = [
  {
    flag: '--root <path>',
    description: 'Resolve the CNOS project from a specific filesystem root.',
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
    id: 'init',
    summary: 'Scaffold a workspace-aware CNOS tree in the current project.',
    usage: 'cnos init [--workspace <id>] [--root <path>] [--json]',
    description:
      'Creates .cnos/cnos.yml, optional .cnos-workspace.yml, config folders, and .gitignore entries without overwriting existing files.',
    examples: ['cnos init', 'cnos init --workspace api', 'cnos init --root ./apps/api --workspace api --json'],
  },
  {
    id: 'onboard',
    summary: 'Onboard an existing repo into CNOS and import root dotenv files.',
    usage: 'cnos onboard [--workspace <id>] [--root <path>] [--move] [--json]',
    description:
      'Scaffolds the CNOS workspace tree and imports root-level .env, .env.<profile>, and .env.*.example files into .cnos/workspaces/<workspace>/env.',
    options: [
      {
        flag: '--move',
        description: 'Move the root env files into CNOS instead of leaving the originals in place.',
      },
    ],
    examples: ['cnos onboard', 'cnos onboard --workspace webapp', 'cnos onboard --root ../my-app --workspace app --move'],
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
        flag: '--prefix <path>',
        description: 'Filter value list output to keys that begin with this logical path or key prefix.',
      },
    ],
    examples: [
      'cnos value app.name',
      'cnos value set server.port 3000',
      'cnos add value app.name demo',
      'cnos value list --prefix app.',
    ],
  },
  {
    id: 'value set',
    summary: 'Write a value.',
    usage: 'cnos value set <path> <value> [--target <local|global>] [global-options]',
    description: 'Writes a deterministic value document into the selected workspace or explicit global target.',
    examples: ['cnos value set app.name demo', 'cnos add value server.port 3000 --target global'],
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
        description: 'Provider name for --remote or --ref secret writes.',
      },
      {
        flag: '--passphrase <value>',
        description: 'Passphrase used to encrypt local secret material when --local is selected.',
      },
      {
        flag: '--vault <name>',
        description: 'Use a manifest-defined vault. Provider behavior is inferred from the vault definition.',
      },
    ],
    examples: [
      'cnos secret app.token',
      'cnos vault create local-dev --passphrase dev-pass',
      'cnos secret set app.token super-secret --vault local-dev',
      'cnos vault create github-ci --provider github-secrets --no-passphrase',
      'cnos secret set app.token APP_TOKEN --vault github-ci',
    ],
  },
  {
    id: 'vault',
    summary: 'Manage manifest-defined secret vaults.',
    usage: 'cnos vault [create <name> | list | remove <name>] [options] [global-options]',
    description:
      'Creates, lists, and removes vault definitions in .cnos/cnos.yml. Local vaults use encrypted material under ~/.cnos/secrets, while github-secrets vaults resolve from process.env in CI.',
    options: [
      {
        flag: '--provider <local|github-secrets>',
        description: 'Vault provider. Defaults to local.',
      },
      {
        flag: '--passphrase <value>',
        description: 'Required for local vault creation unless already available in the configured passphrase env var.',
      },
      {
        flag: '--no-passphrase',
        description: 'Allowed for passwordless providers such as github-secrets.',
      },
    ],
    examples: [
      'cnos vault create local-dev --passphrase dev-pass',
      'cnos vault create github-ci --provider github-secrets --no-passphrase',
      'cnos vault list',
      'cnos vault remove local-dev',
    ],
  },
  {
    id: 'vault create',
    summary: 'Create a manifest-defined vault.',
    usage: 'cnos vault create <name> [--provider <local|github-secrets>] [--passphrase <value>] [--no-passphrase] [global-options]',
    description:
      'Creates a vault definition in .cnos/cnos.yml and, for local vaults, initializes the encrypted store under ~/.cnos/secrets.',
    examples: [
      'cnos vault create local-dev --passphrase dev-pass',
      'cnos vault create github-ci --provider github-secrets --no-passphrase',
    ],
  },
  {
    id: 'vault list',
    summary: 'List manifest-defined vaults.',
    usage: 'cnos vault list [global-options]',
    description: 'Lists vault definitions together with provider and passphrase policy.',
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
    usage: 'cnos list [value|secret|meta|env|public|all] [--prefix <path>] [global-options]',
    description:
      'Lists stored config or derived projections across one namespace or the full effective graph, with optional prefix filtering.',
    options: [
      {
        flag: '--namespace <value|secret|meta|env|public|all>',
        description: 'Explicit namespace selector when not using a positional namespace argument.',
      },
      {
        flag: '--prefix <path>',
        description: 'Filter list output to entries whose logical keys begin with this prefix.',
      },
    ],
    examples: ['cnos list', 'cnos list value --prefix app.', 'cnos list env', 'cnos list --namespace secret'],
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
        description: 'Parent profile to extend when creating a profile.',
      },
    ],
    examples: [
      'cnos profile create stage --inherit base',
      'cnos profile list',
      'cnos profile use stage',
    ],
  },
  {
    id: 'profile create',
    summary: 'Create a profile definition.',
    usage: 'cnos profile create <name> [--inherit <name>] [--root <path>] [--json]',
    description: 'Creates .cnos/profiles/<name>.yml for an explicit profile overlay.',
    examples: ['cnos profile create stage --inherit base'],
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
    usage: 'cnos promote <key...> --to <public|env> [--as <ENV_VAR>] [global-options]',
    description:
      'Adds keys to public.promote or envMapping.explicit in .cnos/cnos.yml. Sensitive or non-shareable namespaces are rejected.',
    options: [
      {
        flag: '--to <public|env>',
        description: 'Choose whether the keys are promoted to the public surface or env export surface.',
      },
      {
        flag: '--as <ENV_VAR>',
        description: 'Required for --to env. Sets the exported env var name for the promoted key.',
      },
    ],
    examples: [
      'cnos promote value.flag.auth.upi_enabled --to public',
      'cnos promote value.server.port --to env --as PORT',
    ],
  },
  {
    id: 'secret set',
    summary: 'Write a secret securely.',
    usage: 'cnos secret set <path> <value> [--local|--remote|--ref] [--vault <name>] [--provider <name>] [--passphrase <value>] [global-options]',
    description:
      'Writes a secret reference into the repo. When a local vault is selected, CNOS stores encrypted secret material outside the repo under ~/.cnos/secrets/vaults/<vault>; when a github-secrets vault is selected, CNOS writes a CI env-backed ref.',
    examples: [
      'cnos vault create db --passphrase dev-pass',
      'cnos secret set app.token super-secret --vault db',
      'cnos vault create github-ci --provider github-secrets --no-passphrase',
      'cnos secret set app.token APP_TOKEN --vault github-ci',
    ],
  },
  {
    id: 'secret create vault',
    summary: 'Create a local secret vault.',
    usage: 'cnos secret create vault <name> --passphrase <value> [global-options]',
    description: 'Alias for cnos vault create <name>.',
    examples: ['cnos secret create vault db --passphrase dev-pass'],
  },
  {
    id: 'secret list',
    summary: 'List resolved secrets.',
    usage: 'cnos secret list [--vault <name>] [--provider <name>] [global-options]',
    description: 'Lists stored secret entries for the selected workspace and profile, optionally filtered by vault or provider.',
    examples: ['cnos secret list --workspace api', 'cnos secret list --vault github-ci'],
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
      'Shows the resolved value, namespace, active profile, workspace context, and the loader/origin that won precedence.',
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
    id: 'export env',
    summary: 'Render environment variables for the selected workspace.',
    usage: 'cnos export env [--public] [--framework <name>] [--prefix <prefix>] [global-options]',
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
    ],
    examples: ['cnos export env', 'cnos export env --public --framework vite --workspace api'],
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
    usage: 'cnos run [global-options] -- <command...>',
    description:
      'Resolves the active workspace and profile, injects runtime env variables, and executes the command after --.',
    examples: ['cnos run -- node server.js', 'cnos run --workspace api -- pnpm dev'],
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
    usage: 'cnos doctor [global-options]',
    description:
      'Checks manifest/workspace setup, gitignore coverage, and related diagnostics for the selected workspace.',
    examples: ['cnos doctor', 'cnos doctor --workspace api --json'],
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
    summary: 'Inject CNOS public env into Vite define replacements and import.meta.env.',
    usage: 'import { createCnosVitePlugin } from "@kitsy/cnos-vite"',
    examples: ['cnos export env --public --framework vite', 'vite.config.ts -> plugins: [createCnosVitePlugin()]'],
  },
  {
    id: 'next',
    packageName: '@kitsy/cnos-next',
    entrypoint: '@kitsy/cnos-next',
    summary: 'Merge CNOS public env into next.config.* using the NEXT_PUBLIC_ convention.',
    usage: 'import { withCnosNext } from "@kitsy/cnos-next"',
    examples: ['cnos export env --public --framework next', 'next.config.mjs -> export default withCnosNext({})'],
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
    'cnos export env --public --framework vite',
    'cnos export env --public --framework next',
    'cnos help-ai --format json',
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
