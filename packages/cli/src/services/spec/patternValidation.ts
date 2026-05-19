export function assertValidSpecPattern(pattern: string): void {
  try {
    // Validate regex syntax only; flags are not supported in schema pattern fields.
    void new RegExp(pattern);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid --pattern regex: ${reason}`);
  }
}
