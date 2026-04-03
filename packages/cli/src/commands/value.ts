import { createRuntimeService } from '../services/runtime.js';

export async function runValue(key: string): Promise<string> {
  const runtime = await createRuntimeService();
  const value = runtime.require(key);

  return String(value);
}
