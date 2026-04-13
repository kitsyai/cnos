import { printJson } from '../format/printJson.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';
import { clearCachedRoots, listCachedRoots, refreshCachedRoots } from '../services/cache.js';

function normalizeAction(args: string[]): { action: 'list' | 'clear' | 'refresh'; target?: string } {
  const [action = 'list', target] = args;

  if (action === 'list' || action === 'clear' || action === 'refresh') {
    return {
      action,
      ...(typeof target === 'string' ? { target } : {}),
    };
  }

  return {
    action: 'list',
    ...(typeof args[0] === 'string' ? { target: args[0] } : {}),
  };
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${Math.round((sizeBytes / 1024) * 10) / 10} KB`;
  }

  return `${Math.round((sizeBytes / (1024 * 1024)) * 10) / 10} MB`;
}

export async function runCache(args: string[] = [], options: RuntimeServiceOptions = {}): Promise<string> {
  const { action, target } = normalizeAction(args);

  if (action === 'clear') {
    const result = await clearCachedRoots(target, options.processEnv ?? process.env);
    return options.json ? printJson(result) : `cleared ${result.cleared.length} cached root(s)`;
  }

  if (action === 'refresh') {
    const result = await refreshCachedRoots(target, options);
    return options.json ? printJson(result) : `refreshed ${result.refreshed.length} cached root(s)`;
  }

  const records = await listCachedRoots(options.processEnv ?? process.env);

  if (options.json) {
    return printJson(records);
  }

  if (records.length === 0) {
    return 'no cached remote roots';
  }

  return records
    .map((record) =>
      [
        record.uri,
        `  cached: ${record.cachedAt}`,
        `  commit: ${record.resolvedCommit}`,
        `  immutable: ${record.immutable ? 'yes' : 'no'}`,
        `  size: ${formatBytes(record.sizeBytes)}`,
      ].join('\n'),
    )
    .join('\n\n');
}
