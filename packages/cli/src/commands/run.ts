import { spawn, type ChildProcess } from 'node:child_process';

import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  command: string[],
  options: RuntimeServiceOptions & { stdio?: 'inherit' | 'pipe' } = {},
): Promise<RunCommandResult> {
  if (command.length === 0) {
    throw new Error('run requires a command after --');
  }

  const runtime = await createRuntimeService(options);
  const env = {
    ...process.env,
    ...runtime.toEnv(),
  };

  return new Promise<RunCommandResult>((resolve, reject) => {
    const executable = command[0];

    if (!executable) {
      reject(new Error('run requires a command after --'));
      return;
    }

    const child: ChildProcess = spawn(executable, command.slice(1), {
      cwd: options.root ?? process.cwd(),
      env,
      stdio: options.stdio === 'pipe' ? 'pipe' : 'inherit',
      shell: false,
    });
    let stdout = '';
    let stderr = '';

    if (options.stdio === 'pipe') {
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
    }

    child.on('error', reject);
    child.on('close', (code: number | null) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
