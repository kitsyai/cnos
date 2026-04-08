import { watch, type FSWatcher } from 'node:fs';

import { loadManifest } from '@kitsy/cnos-core';

import { writeCodegenOutput, type CodegenWriteResult, type WriteCodegenOutputOptions } from './writeOutput.js';

export interface WatchSchemaOptions extends WriteCodegenOutputOptions {
  debounceMs?: number;
  onWrite?: (result: CodegenWriteResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export async function watchSchema(options: WatchSchemaOptions = {}): Promise<FSWatcher> {
  const loadedManifest = await loadManifest(options.root ? { root: options.root } : {});
  let timeout: NodeJS.Timeout | undefined;
  const debounceMs = options.debounceMs ?? 300;

  const runWrite = async (): Promise<void> => {
    try {
      const result = await writeCodegenOutput(options);
      await options.onWrite?.(result);
    } catch (error) {
      await options.onError?.(error);
    }
  };

  await runWrite();

  const watcher = watch(loadedManifest.manifestPath, () => {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      void runWrite();
    }, debounceMs);
  });

  watcher.on('close', () => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });

  return watcher;
}
