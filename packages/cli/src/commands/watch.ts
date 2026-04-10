import type { ChildProcess } from 'node:child_process';

import {
  CNOS_GRAPH_ENV_VAR,
  CNOS_SECRET_PAYLOAD_ENV_VAR,
  CNOS_SESSION_KEY_ENV_VAR,
  serializeRuntimeGraph,
  serializeSecretPayload,
} from '@kitsy/cnos/internal';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';
import { spawnCommand } from '../services/spawn.js';
import { startGraphWatchLoop } from '../services/watchLoop.js';

export interface WatchLoopHandle {
  close(): Promise<void>;
}

export interface StartWatchLoopOptions extends RuntimeServiceOptions {
  command?: string[];
  onSignal?: (payload: { changedKeys: string[] }) => void | Promise<void>;
  onRestart?: (payload: { changedKeys: string[] }) => void | Promise<void>;
}

async function buildRunEnvironment(
  options: RuntimeServiceOptions,
): Promise<{
  runtime: Awaited<ReturnType<typeof createRuntimeService>>;
  env: NodeJS.ProcessEnv;
}> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const isPublic = consumeFlag(cliArgs, '--public');
  const isAuthenticated = consumeFlag(cliArgs, '--auth');
  const framework = consumeOption(cliArgs, '--framework');
  const prefix = consumeOption(cliArgs, '--prefix');
  const runtime = await createRuntimeService({
    ...options,
    cliArgs,
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

  return {
    runtime,
    env: {
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
    },
  };
}

function spawnWatchedChild(command: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const executable = command[0];

  if (!executable) {
    throw new Error('watch requires a command after -- unless --signal is used');
  }

  return spawnCommand(command, {
    cwd,
    env,
    stdio: 'inherit',
  });
}

export async function startWatchLoop(options: StartWatchLoopOptions): Promise<WatchLoopHandle> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const isSignal = consumeFlag(cliArgs, '--signal');
  const debounceMs = Number(consumeOption(cliArgs, '--debounce') ?? '300');
  const command = options.command ?? [];
  const root = options.root ?? process.cwd();
  let current = await buildRunEnvironment({
    ...options,
    cliArgs,
  });
  let child = !isSignal ? spawnWatchedChild(command, root, current.env) : undefined;
  let closed = false;
  const watcher = await startGraphWatchLoop({
    ...options,
    cliArgs,
    debounceMs,
    async onChange(payload) {
      if (closed) {
        return;
      }

      current = await buildRunEnvironment({
        ...options,
        cliArgs,
      });

      if (isSignal) {
        await options.onSignal?.({ changedKeys: payload.changedKeys });
        process.stdout.write(`${printJson({ changedKeys: payload.changedKeys })}\n`);
        return;
      }

      if (child && !child.killed) {
        await new Promise<void>((resolve) => {
          child?.once('close', () => resolve());
          child?.kill();
        });
      }

      child = spawnWatchedChild(command, root, current.env);
      await options.onRestart?.({ changedKeys: payload.changedKeys });
    },
  });

  return {
    async close() {
      closed = true;
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

export async function runWatch(
  command: string[],
  options: RuntimeServiceOptions = {},
): Promise<string> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const isSignal = consumeFlag(cliArgs, '--signal');
  const debounce = consumeOption(cliArgs, '--debounce');
  const handle = await startWatchLoop({
    ...options,
    cliArgs: [
      ...cliArgs,
      ...(isSignal ? ['--signal'] : []),
      ...(debounce ? ['--debounce', debounce] : []),
    ],
    command,
  });

  const closeWatcher = (): void => {
    void handle.close();
  };

  process.once('SIGINT', closeWatcher);
  process.once('SIGTERM', closeWatcher);

  return isSignal ? 'watching config changes in signal mode' : 'watching config changes in restart mode';
}
