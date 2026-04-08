export const MASKED_SECRET_VALUE = '****';

export function maskSecretValue(value: unknown): string {
  return value === undefined ? '' : MASKED_SECRET_VALUE;
}
