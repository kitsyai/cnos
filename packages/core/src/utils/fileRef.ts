export interface FileReference {
  $file: string;
}

export function isFileReference(value: unknown): value is FileReference {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      '$file' in (value as Record<string, unknown>) &&
      typeof (value as Record<string, unknown>)['$file'] === 'string',
  );
}
