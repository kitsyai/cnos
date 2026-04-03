export interface CommandOptions {
  root?: string;
  workspace?: string;
  profile?: string;
  globalRoot?: string;
  json?: boolean;
  help?: boolean;
  cliArgs: string[];
}

export interface ParsedCommand {
  command: string;
  args: string[];
  options: CommandOptions;
  passthrough: string[];
}

const OPTION_KEYS = {
  '--root': 'root',
  '--workspace': 'workspace',
  '--profile': 'profile',
  '--global-root': 'globalRoot',
} as const;

const COMMAND_OPTION_KEYS_WITH_VALUE = new Set(['--format', '--framework', '--prefix', '--target', '--to']);
const COMMAND_FLAG_KEYS = new Set(['--flatten', '--public']);
type ConfigOptionKey = (typeof OPTION_KEYS)[keyof typeof OPTION_KEYS];

function setOption(
  options: Omit<CommandOptions, 'cliArgs'>,
  key: ConfigOptionKey,
  value: string,
): void {
  options[key] = value;
}

export function parseArgs(argv: string[]): ParsedCommand {
  if (argv[0] === '--help' || argv[0] === '-h') {
    return {
      command: 'help',
      args: [],
      options: {
        cliArgs: [],
      },
      passthrough: [],
    };
  }

  const [command = 'doctor', ...rest] = argv;
  const options: Omit<CommandOptions, 'cliArgs'> = {};
  const args: string[] = [];
  const cliArgs: string[] = [];
  const passthrough: string[] = [];
  let passthroughMode = false;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (!token) {
      continue;
    }

    if (token === '--') {
      passthroughMode = true;
      continue;
    }

    if (passthroughMode) {
      passthrough.push(token);
      continue;
    }

    if (token === '--json') {
      options.json = true;
      continue;
    }

    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }

    const optionKey = Object.keys(OPTION_KEYS).find(
      (candidate) => token === candidate || token.startsWith(`${candidate}=`),
    ) as keyof typeof OPTION_KEYS | undefined;

    if (optionKey) {
      const inlineValue = token.includes('=') ? token.slice(token.indexOf('=') + 1) : undefined;
      const nextValue = inlineValue ?? rest[index + 1];

      if (!nextValue) {
        throw new Error(`Missing value for ${optionKey}`);
      }

      setOption(options, OPTION_KEYS[optionKey], nextValue);

      if (!inlineValue) {
        index += 1;
      }

      continue;
    }

    if (token.startsWith('--')) {
      cliArgs.push(token);

      const rawKey = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;

      if (!token.includes('=') && COMMAND_OPTION_KEYS_WITH_VALUE.has(rawKey)) {
        const nextValue = rest[index + 1];

        if (!nextValue || nextValue.startsWith('--')) {
          throw new Error(`Missing value for ${rawKey}`);
        }

        cliArgs.push(nextValue);
        index += 1;
        continue;
      }

      if (COMMAND_FLAG_KEYS.has(rawKey)) {
        continue;
      }

      continue;
    }

    args.push(token);
  }

  return {
    command,
    args,
    options: {
      ...options,
      cliArgs,
    },
    passthrough,
  };
}
