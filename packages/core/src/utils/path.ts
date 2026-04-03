export function joinConfigPath(...parts: string[]): string {
  return parts.filter(Boolean).join('.');
}
