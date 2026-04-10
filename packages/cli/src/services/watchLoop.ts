import { watch, type FSWatcher } from 'node:fs';

import { diffGraphs, watchFiles } from '@kitsy/cnos/internal';

import { createRuntimeService, type RuntimeServiceOptions } from './runtime.js';

export interface GraphWatchLoopHandle {
  close(): Promise<void>;
}

export interface StartGraphWatchLoopOptions extends RuntimeServiceOptions {
  debounceMs?: number;
  onChange?: (
    payload: {
      runtime: Awaited<ReturnType<typeof createRuntimeService>>;
      changedKeys: string[];
    },
  ) => void | Promise<void>;
}

export async function startGraphWatchLoop(
  options: StartGraphWatchLoopOptions,
): Promise<GraphWatchLoopHandle> {
  const debounceMs = options.debounceMs ?? 300;
  let current = await createRuntimeService(options);
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
    const nextTargets = await watchFiles(current, options.root);
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

    const next = await createRuntimeService(options);
    const changedKeys = diffGraphs(current.graph, next.graph);
    current = next;
    await refreshWatchers();

    if (changedKeys.length === 0) {
      return;
    }

    await options.onChange?.({
      runtime: next,
      changedKeys,
    });
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
    },
  };
}
