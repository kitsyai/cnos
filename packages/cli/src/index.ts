#!/usr/bin/env node

import { parseArgs } from './cli/parseArgs.js';
import { runDefine } from './commands/define.js';
import { runDoctor } from './commands/doctor.js';
import { runExport } from './commands/export.js';
import { runInit } from './commands/init.js';
import { runInspect } from './commands/inspect.js';
import { runRead } from './commands/read.js';
import { runSecret } from './commands/secret.js';
import { runValidate } from './commands/validate.js';
import { runValue } from './commands/value.js';

export async function main(argv: string[]): Promise<void> {
  const { command, args, options } = parseArgs(argv);
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
    case 'init':
      process.stdout.write(`${await runInit(runtimeOptions)}\n`);
      return;
    case 'read':
      process.stdout.write(`${await runRead(args[0] ?? 'value.app.name', runtimeOptions)}\n`);
      return;
    case 'value':
      process.stdout.write(`${await runValue(args[0] ?? 'app.name', runtimeOptions)}\n`);
      return;
    case 'secret':
      process.stdout.write(`${await runSecret(args[0] ?? 'app.token', runtimeOptions)}\n`);
      return;
    case 'define':
      process.stdout.write(`${runDefine()}\n`);
      return;
    case 'inspect':
      process.stdout.write(`${await runInspect(args[0] ?? 'meta.profile', runtimeOptions)}\n`);
      return;
    case 'validate':
      process.stdout.write(`${runValidate()}\n`);
      return;
    case 'export':
      process.stdout.write(`${runExport()}\n`);
      return;
    case 'doctor':
      process.stdout.write(`${runDoctor()}\n`);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
