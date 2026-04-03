export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>,
): T {
  const merged = { ...base } as Record<string, unknown>;

  for (const [key, value] of Object.entries(override)) {
    const currentValue = merged[key];

    if (
      currentValue &&
      value &&
      typeof currentValue === 'object' &&
      typeof value === 'object' &&
      !Array.isArray(currentValue) &&
      !Array.isArray(value)
    ) {
      merged[key] = deepMerge(
        currentValue as Record<string, unknown>,
        value as Record<string, unknown>,
      );
      continue;
    }

    merged[key] = value;
  }

  return merged as T;
}
