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

export interface HelpDocument {
  name: string;
  summary: string;
  usage: string;
  description: string;
  globalOptions: HelpOption[];
  commands: HelpCommand[];
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
      'Creates cnos/cnos.yml, .cnos-workspace.yml, workspace folders, and .gitignore entries without overwriting existing files.',
    examples: ['cnos init', 'cnos init --workspace api', 'cnos init --root ./apps/api --workspace api --json'],
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
    summary: 'Read a value namespace key without the value. prefix.',
    usage: 'cnos value <path> [global-options]',
    description: 'Reads value.<path> from the selected workspace and profile.',
    arguments: [
      {
        name: 'path',
        description: 'Value path without the value. namespace prefix.',
        required: true,
      },
    ],
    examples: ['cnos value app.name', 'cnos value server.port --profile stage --workspace api'],
  },
  {
    id: 'secret',
    summary: 'Read a secret namespace key without the secret. prefix.',
    usage: 'cnos secret <path> [global-options]',
    description: 'Reads secret.<path> from the selected workspace and profile.',
    arguments: [
      {
        name: 'path',
        description: 'Secret path without the secret. namespace prefix.',
        required: true,
      },
    ],
    examples: ['cnos secret app.token', 'cnos secret service.apiKey --workspace agents'],
  },
  {
    id: 'define',
    summary: 'Write a value or secret into the selected workspace.',
    usage: 'cnos define <value|secret> <path> <rawValue> [--target <local|global>] [global-options]',
    description:
      'Writes deterministic YAML into the selected workspace. Global writes require allowWrite and an explicit --target global flag.',
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
      'cnos define secret app.token super-secret --workspace api --target global',
    ],
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
    examples: ['cnos export env', 'cnos export env --public --framework vite --workspace api'],
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
        description: 'Apply framework-specific public env conventions such as vite or nextjs.',
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
];

export const HELP_DOCUMENT: HelpDocument = {
  name: 'cnos',
  summary: 'Workspace-aware configuration runtime and CLI for local, global, and promoted environment data.',
  usage: 'cnos <command> [args] [options]',
  description:
    'CNOS resolves one active workspace per invocation, layers local and optional global config roots, and exposes read, write, export, dump, validation, and diagnostics commands.',
  globalOptions: GLOBAL_OPTIONS,
  commands: COMMANDS,
  examples: ['cnos doctor --workspace api', 'cnos export env --public --framework vite', 'cnos help-ai --format json'],
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
