export function parseYaml<T>(source: string): T {
  void source;
  throw new Error('YAML parsing is not implemented in the initial CNOS scaffold.');
}

export function stringifyYaml(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
