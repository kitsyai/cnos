import { spawn, type ChildProcess } from 'node:child_process';

import {
  CNOS_GRAPH_ENV_VAR,
  CNOS_SECRET_PAYLOAD_ENV_VAR,
  CNOS_SESSION_KEY_ENV_VAR,
  serializeSecretPayload,
  serializeRuntimeGraph,
} from '@kitsy/cnos/internal';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function consumeOptions(args: string[], flag: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; ) {
    const token = args[index];

    if (token === flag) {
      const value = args[index + 1];

      if (!value) {
        throw new Error(`Missing value for ${flag}`);
      }

      values.push(value);
      args.splice(index, 2);
      continue;
    }

    if (token?.startsWith(`${flag}=`)) {
      values.push(token.slice(flag.length + 1));
      args.splice(index, 1);
      continue;
    }

    index += 1;
  }

  return values;
}

function normalizeSetOverrides(values: string[]): string[] {
  return values.map((value) => {
    if (!value.includes('=')) {
      throw new Error('--set requires <logical-key>=<value>');
    }

    return value.startsWith('--') ? value : `--${value}`;
  });
}

export async function runCommand(
  command: string[],
  options: RuntimeServiceOptions & { stdio?: 'inherit' | 'pipe' } = {},
): Promise<RunCommandResult> {
  if (command.length === 0) {
    throw new Error('run requires a command after --');
  }

  const cliArgs = [...(options.cliArgs ?? [])];
  const isPublic = consumeFlag(cliArgs, '--public');
  const isAuthenticated = consumeFlag(cliArgs, '--auth');
  const framework = consumeOption(cliArgs, '--framework');
  const prefix = consumeOption(cliArgs, '--prefix');
  const setOverrides = normalizeSetOverrides(consumeOptions(cliArgs, '--set'));
  const runtime = await createRuntimeService({
    ...options,
    cliArgs: [...cliArgs, ...setOverrides],
  });
  const authenticatedSecrets =
    isAuthenticated
      ? Object.fromEntries(
          Array.from(runtime.graph.entries.values())
            .filter((entry) => entry.namespace === 'secret')
            .map((entry) => [entry.key, runtime.read(entry.key)]),
        )
      : undefined;
  const secretPayload = authenticatedSecrets ? serializeSecretPayload(authenticatedSecrets) : undefined;
  const env = {
    ...process.env,
    ...(isPublic
      ? runtime.toPublicEnv({
          ...(framework ? { framework } : {}),
          ...(prefix ? { prefix } : {}),
        })
      : runtime.toEnv()),
    [CNOS_GRAPH_ENV_VAR]: serializeRuntimeGraph(runtime.graph),
    ...(secretPayload
      ? {
          [CNOS_SECRET_PAYLOAD_ENV_VAR]: secretPayload.payload,
          [CNOS_SESSION_KEY_ENV_VAR]: secretPayload.sessionKey,
        }
      : {}),
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
