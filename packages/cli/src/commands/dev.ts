import type { ChildProcess } from 'node:child_process';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { displayPath } from '../format/displayPath.js';
import { printJson } from '../format/printJson.js';
import { materializeEnvToFile } from '../services/envMaterialization.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { spawnCommand } from '../services/spawn.js';
import { startGraphWatchLoop } from '../services/watchLoop.js';

export interface DevEnvLoopHandle {
  close(): Promise<void>;
}

export async function startDevEnvLoop(
  command: string[],
  options: RuntimeServiceOptions = {},
): Promise<DevEnvLoopHandle> {
  if (command.length === 0) {
    throw new Error('dev env requires a command after --');
  }

  const cliArgs = [...(options.cliArgs ?? [])];
  const to = consumeOption(cliArgs, '--to');
  const isSignal = consumeFlag(cliArgs, '--signal');
  const debounceMs = Number(consumeOption(cliArgs, '--debounce') ?? '300');

  if (!to) {
    throw new Error('dev env requires --to <path>');
  }

  const root = options.root ?? process.cwd();
  let child: ChildProcess | undefined;

  const writeCurrent = async (): Promise<void> => {
    await materializeEnvToFile(to, {
      ...options,
      cliArgs: [...cliArgs],
    });
  };

  await writeCurrent();

  if (!isSignal) {
    child = spawnCommand(command, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
  }

  const watcher = await startGraphWatchLoop({
    ...options,
    cliArgs,
    debounceMs,
    async onChange(payload) {
      await writeCurrent();

      if (isSignal) {
        process.stdout.write(`${printJson({ changedKeys: payload.changedKeys })}\n`);
        return;
      }

      if (child && !child.killed) {
        await new Promise<void>((resolve) => {
          child?.once('close', () => resolve());
          child?.kill();
        });
      }

      child = spawnCommand(command, {
        cwd: root,
        env: process.env,
        stdio: 'inherit',
      });
    },
  });

  return {
    async close() {
      await watcher.close();

      if (child && !child.killed) {
        await new Promise<void>((resolve) => {
          child?.once('close', () => resolve());
          child?.kill();
        });
      }
    },
  };
}

export async function runDev(
  subcommand: string | undefined,
  command: string[],
  options: RuntimeServiceOptions = {},
): Promise<string> {
  if (subcommand !== 'env') {
    throw new Error(`Unsupported dev target: ${subcommand ?? '(missing)'}`);
  }

  const cliArgs = [...(options.cliArgs ?? [])];
  const to = consumeOption(cliArgs, '--to');
  const isSignal = consumeFlag(cliArgs, '--signal');

  if (!to) {
    throw new Error('dev env requires --to <path>');
  }

  if (command.length === 0) {
    throw new Error('dev env requires a command after --');
  }

  const handle = await startDevEnvLoop(command, {
    ...options,
    cliArgs,
  });

  const closeLoop = (): void => {
    void handle.close();
  };

  process.once('SIGINT', closeLoop);
  process.once('SIGTERM', closeLoop);

  const targetPath = displayPath(to, options.root ?? process.cwd());
  return isSignal
    ? `watching config changes and rewriting ${targetPath} in signal mode`
    : `watching config changes, rewriting ${targetPath}, and restarting the child process`;
}
