import { isDerivedValue } from '../derive/evaluator.js';
import { isSecretReference } from './secretStore.js';

export function flattenObject(
  value: Record<string, unknown>,
  prefix = '',
): Record<string, unknown> {
  return Object.entries(value).reduce<Record<string, unknown>>((accumulator, [key, nestedValue]) => {
    const nextKey = prefix ? `${prefix}.${key}` : key;

    if (isDerivedValue(nestedValue) || isSecretReference(nestedValue)) {
      accumulator[nextKey] = nestedValue;
      return accumulator;
    }

    if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
      Object.assign(accumulator, flattenObject(nestedValue as Record<string, unknown>, nextKey));
      return accumulator;
    }

    accumulator[nextKey] = nestedValue;
    return accumulator;
  }, {});
}
