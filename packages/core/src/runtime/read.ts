import type { LogicalKey, ResolvedGraph } from '../types/core.js';

export function readValue<T = unknown>(graph: ResolvedGraph, key: LogicalKey): T | undefined {
  return graph.entries.get(key)?.value as T | undefined;
}
