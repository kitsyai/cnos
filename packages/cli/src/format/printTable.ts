function stringifyCell(value: unknown): string {
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

export function printTable(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) {
    return '';
  }

  const columns = Array.from(
    rows.reduce((set, row) => {
      for (const key of Object.keys(row)) {
        set.add(key);
      }

      return set;
    }, new Set<string>()),
  );
  const widths = columns.map((column) =>
    Math.max(
      column.length,
      ...rows.map((row) => stringifyCell(row[column]).length),
    ),
  );
  const renderRow = (row: Record<string, unknown>) =>
    columns
      .map((column, index) => {
        const width = widths[index] ?? column.length;
        return stringifyCell(row[column]).padEnd(width, ' ');
      })
      .join('  ')
      .trimEnd();

  return [
    columns
      .map((column, index) => {
        const width = widths[index] ?? column.length;
        return column.padEnd(width, ' ');
      })
      .join('  ')
      .trimEnd(),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.map(renderRow),
  ].join('\n');
}
