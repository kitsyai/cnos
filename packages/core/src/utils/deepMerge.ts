export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>,
): T {
  const merged = { ...base } as Record<string, unknown>;

  for (const [key, value] of Object.entries(override)) {
    const currentValue = merged[key];

    if (isPlainObject(currentValue) && isPlainObject(value)) {
      merged[key] = deepMerge(currentValue, value);
      continue;
    }

    merged[key] = value;
  }

  return merged as T;
}
