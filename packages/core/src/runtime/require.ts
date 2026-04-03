import type { CnosConfigEntry } from '../types/core.js';
import { readValue } from './read.js';

export function requireValue(entries: CnosConfigEntry[], key: string): unknown {
  const value = readValue(entries, key);

  if (value === undefined) {
    throw new Error(`Missing required CNOS config key: ${key}`);
  }

  return value;
}
