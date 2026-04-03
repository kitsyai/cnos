import type { LogicalKey, ResolvedGraph } from '../types/core.js';
import { readValue } from './read.js';

export function readOrValue<T>(graph: ResolvedGraph, key: LogicalKey, fallback: T): T {
  const value = readValue<T>(graph, key);
  return value === undefined ? fallback : value;
}
