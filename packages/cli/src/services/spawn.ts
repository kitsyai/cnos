import { spawn, type ChildProcess } from 'node:child_process';

export function shouldUseShellForCommand(command: string): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  return !/[\\/]/.test(command);
}

export function spawnCommand(
  command: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio?: 'inherit' | 'pipe';
  },
): ChildProcess {
  const executable = command[0];

  if (!executable) {
    throw new Error('A command is required.');
  }

  return spawn(executable, command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? 'inherit',
    shell: shouldUseShellForCommand(executable),
  });
}
