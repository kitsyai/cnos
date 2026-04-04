#!/usr/bin/env node

import { parseArgs } from './cli/parseArgs.js';
import { runDefine } from './commands/define.js';
import { runDiff } from './commands/diff.js';
import { runDoctor } from './commands/doctor.js';
import { runDump } from './commands/dump.js';
import { runExport } from './commands/export.js';
import { runHelp } from './commands/help.js';
import { runHelpAi } from './commands/helpAi.js';
import { runInit } from './commands/init.js';
import { runInspect } from './commands/inspect.js';
import { runOnboard } from './commands/onboard.js';
import { runProfile } from './commands/profile.js';
import { runRead } from './commands/read.js';
import { runCommand } from './commands/run.js';
import { runSecret } from './commands/secret.js';
import { runUse } from './commands/use.js';
import { runValidate } from './commands/validate.js';
import { runValue } from './commands/value.js';
import { normalizeHelpTopic } from './cli/helpRegistry.js';

function resolveHelpTopic(command: string, args: string[]): string | undefined {
  if (command === 'help' || command === 'help-ai') {
    return normalizeHelpTopic(args);
  }

  if (command === 'export' && args[0] === 'env') {
    return normalizeHelpTopic([command, args[0]]);
  }

  if (
    command === 'secret' &&
    args[0] &&
    ['set', 'create', 'add', 'list', 'delete', 'remove'].includes(args[0])
  ) {
    return normalizeHelpTopic([
      command,
      args[0] === 'remove' ? 'delete' : args[0] === 'create' || args[0] === 'add' ? 'set' : args[0],
    ]);
  }

  if (command === 'profile' && args[0] && ['create', 'list', 'use', 'delete', 'remove'].includes(args[0])) {
    return normalizeHelpTopic([command, args[0] === 'remove' ? 'delete' : args[0]]);
  }

  return normalizeHelpTopic([command]);
}

export async function main(argv: string[]): Promise<void> {
  const { command, args, options, passthrough } = parseArgs(argv);

  if (options.help) {
    process.stdout.write(`${runHelp(resolveHelpTopic(command, args))}\n`);
    return;
  }

  const runtimeOptions = {
    ...(options.root
      ? {
          root: options.root,
        }
      : {}),
    ...(options.workspace
      ? {
          workspace: options.workspace,
        }
      : {}),
    ...(options.profile
      ? {
          profile: options.profile,
        }
      : {}),
    ...(options.globalRoot
      ? {
          globalRoot: options.globalRoot,
        }
      : {}),
    ...(options.json
      ? {
          json: true,
        }
      : {}),
    ...(options.cliArgs.length > 0
      ? {
          cliArgs: options.cliArgs,
        }
      : {}),
  };

  switch (command) {
    case 'help':
      process.stdout.write(`${runHelp(resolveHelpTopic(command, args))}\n`);
      return;
    case 'help-ai':
      process.stdout.write(`${runHelpAi(resolveHelpTopic(command, args), options.cliArgs)}\n`);
      return;
    case 'init':
      process.stdout.write(`${await runInit(runtimeOptions)}\n`);
      return;
    case 'onboard':
      process.stdout.write(`${await runOnboard(runtimeOptions)}\n`);
      return;
    case 'read':
      process.stdout.write(`${await runRead(args[0] ?? 'value.app.name', runtimeOptions)}\n`);
      return;
    case 'value':
      process.stdout.write(`${await runValue(args[0] ?? 'app.name', runtimeOptions)}\n`);
      return;
    case 'secret':
      process.stdout.write(`${await runSecret(args.length > 0 ? args : ['app.token'], runtimeOptions)}\n`);
      return;
    case 'use':
      process.stdout.write(`${await runUse(runtimeOptions)}\n`);
      return;
    case 'profile':
      process.stdout.write(`${await runProfile(args, runtimeOptions)}\n`);
      return;
    case 'define':
      process.stdout.write(
        `${await runDefine((args[0] as 'value' | 'secret') ?? 'value', args[1] ?? 'app.name', args[2] ?? '', runtimeOptions)}\n`,
      );
      return;
    case 'inspect':
      process.stdout.write(`${await runInspect(args[0] ?? 'meta.profile', runtimeOptions)}\n`);
      return;
    case 'validate':
      process.stdout.write(`${await runValidate(runtimeOptions)}\n`);
      return;
    case 'export':
      process.stdout.write(`${await runExport(args[0], runtimeOptions)}\n`);
      return;
    case 'dump':
      process.stdout.write(`${await runDump(runtimeOptions)}\n`);
      return;
    case 'run': {
      const result = await runCommand(passthrough.length > 0 ? passthrough : args, {
        ...runtimeOptions,
        stdio: 'inherit',
      });
      process.exitCode = result.exitCode;
      return;
    }
    case 'diff':
      process.stdout.write(`${await runDiff(args[0] ?? 'local', args[1] ?? 'stage', runtimeOptions)}\n`);
      return;
    case 'doctor':
      process.stdout.write(`${await runDoctor(runtimeOptions)}\n`);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
