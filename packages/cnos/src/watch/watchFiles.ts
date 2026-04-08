import path from 'node:path';

import { loadManifest } from '@kitsy/cnos-core';
import type { CnosRuntime } from '@kitsy/cnos-core';

export interface WatchTargetSet {
  manifestPath: string;
  roots: string[];
  files: string[];
}

export async function watchFiles(runtime: CnosRuntime, root?: string): Promise<WatchTargetSet> {
  const manifest = await loadManifest(root ? { root } : {});
  const roots = Array.from(
    new Set(runtime.graph.workspace.workspaceRoots.map((workspaceRoot) => workspaceRoot.path)),
  ).sort((left, right) => left.localeCompare(right));
  const files = Array.from(
    new Set(
      Array.from(runtime.graph.entries.values())
        .map((entry) => entry.winner.origin?.file)
        .filter((file): file is string => Boolean(file))
        .map((file) => path.resolve(manifest.repoRoot, file)),
    ),
  ).sort((left, right) => left.localeCompare(right));

  return {
    manifestPath: manifest.manifestPath,
    roots,
    files,
  };
}
