function stringify(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  return JSON.stringify(value);
}

export const DERIVE_BUILTINS = {
  concat: (...args: unknown[]) => args.map((value) => stringify(value)).join(''),
  coalesce: (...args: unknown[]) => args.find((value) => value !== undefined && value !== null),
  when: (condition: unknown, whenTrue: unknown, whenFalse: unknown) => (condition ? whenTrue : whenFalse),
  exists: (value: unknown) => value !== undefined && value !== null,
  eq: (left: unknown, right: unknown) => left === right,
  ne: (left: unknown, right: unknown) => left !== right,
} as const;

export type DeriveBuiltinName = keyof typeof DERIVE_BUILTINS;
