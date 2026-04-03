export function toConfigKey(filePath: string): string {
  return filePath.replace(/[\\/]+/g, '.').replace(/^\.+|\.+$/g, '');
}
