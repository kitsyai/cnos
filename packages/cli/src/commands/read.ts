import { createRuntimeService } from '../services/runtime.js';

export async function runRead(key: string): Promise<string> {
  const runtime = await createRuntimeService();
  const value = runtime.read(key);

  return JSON.stringify({ key, value }, null, 2);
}
