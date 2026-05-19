export type ProjectionFormat = 'dotenv' | 'docker-env' | 'json' | 'shell' | 'toml' | 'yaml';

const DOTENV_SAFE_UNQUOTED = /^[A-Za-z0-9_./:@%+*-]+$/;

function escapeDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"');
}

function requiresDotenvQuoting(value: string): boolean {
  return (
    value.length === 0 ||
    !DOTENV_SAFE_UNQUOTED.test(value) ||
    value.includes(' ') ||
    value.includes('#') ||
    value.includes('$')
  );
}

function quoteDotenv(value: string): string {
  if (!requiresDotenvQuoting(value)) {
    return value;
  }

  return `"${escapeDoubleQuoted(value)}"`;
}

function quoteToml(value: string): string {
  return `"${escapeDoubleQuoted(value)}"`;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function stringifyScalar(value: unknown): string {
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

export function formatEnvEntries(
  values: Record<string, unknown>,
  format: 'dotenv' | 'docker-env' | 'shell' | 'toml' = 'dotenv',
): string {
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));

  switch (format) {
    case 'shell':
      return entries.map(([key, value]) => `export ${key}=${quoteShell(stringifyScalar(value))}`).join('\n');
    case 'toml':
      return entries.map(([key, value]) => `${key} = ${quoteToml(stringifyScalar(value))}`).join('\n');
    case 'docker-env':
    case 'dotenv':
    default:
      return entries.map(([key, value]) => `${key}=${quoteDotenv(stringifyScalar(value))}`).join('\n');
  }
}
