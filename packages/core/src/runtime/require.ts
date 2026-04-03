import { CnosKeyNotFoundError } from '../errors.js';
import type { LogicalKey, ResolvedGraph } from '../types/core.js';
import { readValue } from './read.js';

export function requireValue<T = unknown>(graph: ResolvedGraph, key: LogicalKey): T {
  const value = readValue<T>(graph, key);

  if (value === undefined) {
    throw new CnosKeyNotFoundError(key);
  }

  return value;
}
