import { printJson } from './printJson.js';

export function printValue(value: unknown, json = false): string {
  if (json) {
    return printJson(value);
  }

  if (typeof value === 'string') {
    return value;
  }

  if (
    value === undefined ||
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }

  return printJson(value);
}
