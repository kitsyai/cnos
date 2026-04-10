import { watch, type FSWatcher } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  CNOS_GRAPH_ENV_VAR,
  CNOS_SECRET_PAYLOAD_ENV_VAR,
  CNOS_SESSION_KEY_ENV_VAR,
  diffGraphs,
  serializeRuntimeGraph,
  serializeSecretPayload,
  watchFiles,
} from '@kitsy/cnos/internal';

import { consumeFlag, consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';

export interface WatchLoopHandle {
  close(): Promise<void>;
}

export interface StartWatchLoopOptions extends RuntimeServiceOptions {
  command?: string[];
  onSignal?: (payload: { changedKeys: string[] }) => void | Promise<void>;
  onRestart?: (payload: { changedKeys: string[] }) => void | Promise<void>;
}

function shouldUseShellForCommand(command: string): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  return !/[\\/]/.test(command);
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

  return spawn(executable, command.slice(1), {
    cwd,
    env,
    stdio: 'inherit',
    shell: shouldUseShellForCommand(executable),
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
  const watcherMap = new Map<string, FSWatcher>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const attachWatcher = (targetPath: string, recursive = false): void => {
    if (watcherMap.has(targetPath)) {
      return;
    }

    try {
      const watcher = watch(
        targetPath,
        recursive
          ? {
              recursive: true,
            }
          : undefined,
        () => {
          if (timer) {
            clearTimeout(timer);
          }

          timer = setTimeout(() => {
            void handleChange();
          }, debounceMs);
        },
      );
      watcherMap.set(targetPath, watcher);
    } catch {
      if (recursive) {
        attachWatcher(targetPath, false);
      }
    }
  };

  const refreshWatchers = async (): Promise<void> => {
    const nextTargets = await watchFiles(current.runtime, options.root);
    attachWatcher(nextTargets.manifestPath, false);

    for (const workspaceRoot of nextTargets.roots) {
      attachWatcher(workspaceRoot, true);
    }

    for (const filePath of nextTargets.files) {
      attachWatcher(filePath, false);
    }
  };

  const handleChange = async (): Promise<void> => {
    if (closed) {
      return;
    }

    const next = await buildRunEnvironment({
      ...options,
      cliArgs,
    });
    const changedKeys = diffGraphs(current.runtime.graph, next.runtime.graph);
    current = next;
    await refreshWatchers();

    if (changedKeys.length === 0) {
      return;
    }

    if (isSignal) {
      await options.onSignal?.({ changedKeys });
      process.stdout.write(`${printJson({ changedKeys })}\n`);
      return;
    }

    if (child && !child.killed) {
      await new Promise<void>((resolve) => {
        child?.once('close', () => resolve());
        child?.kill();
      });
    }

    child = spawnWatchedChild(command, root, current.env);
    await options.onRestart?.({ changedKeys });
  };

  await refreshWatchers();

  return {
    async close() {
      closed = true;

      if (timer) {
        clearTimeout(timer);
      }

      for (const watcher of watcherMap.values()) {
        watcher.close();
      }

      watcherMap.clear();

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
