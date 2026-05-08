import { spawn, type ChildProcess } from 'node:child_process';

export function shouldUseWindowsCommandShim(command: string): boolean {
  return process.platform === 'win32' && !/[\\/]/.test(command);
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

  if (shouldUseWindowsCommandShim(executable)) {
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', ...command], {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? 'inherit',
    });
  }

  return spawn(executable, command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? 'inherit',
  });
}
