/**
 * Parse a CNOS duration string (e.g. `30s`, `10m`, `1h`, `500ms`) into milliseconds.
 * Bare numbers are treated as seconds. Returns `undefined` for empty/undefined input and
 * throws for malformed strings.
 */
export function parseDuration(input: string | undefined): number | undefined {
  if (input === undefined) {
    return undefined;
  }

  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(trimmed);

  if (!match) {
    throw new Error(`Invalid duration "${input}". Use forms like "500ms", "30s", "10m", "1h".`);
  }

  const amount = Number(match[1]);
  const unit = match[2] ?? 's';

  const factors: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  return amount * (factors[unit] ?? 1000);
}
