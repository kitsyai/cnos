#!/usr/bin/env node

import { runDefine } from './commands/define.js';
import { runDoctor } from './commands/doctor.js';
import { runExport } from './commands/export.js';
import { runInit } from './commands/init.js';
import { runInspect } from './commands/inspect.js';
import { runRead } from './commands/read.js';
import { runValidate } from './commands/validate.js';
import { runValue } from './commands/value.js';

async function main(argv: string[]): Promise<void> {
  const [command = 'doctor', arg] = argv;

  switch (command) {
    case 'init':
      process.stdout.write(`${runInit()}\n`);
      return;
    case 'read':
      process.stdout.write(`${await runRead(arg ?? 'app.name')}\n`);
      return;
    case 'value':
      process.stdout.write(`${await runValue(arg ?? 'app.name')}\n`);
      return;
    case 'define':
      process.stdout.write(`${runDefine()}\n`);
      return;
    case 'inspect':
      process.stdout.write(`${await runInspect()}\n`);
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
