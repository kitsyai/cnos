import { createRuntimeService } from '../services/runtime.js';
import { printInspect } from '../format/printInspect.js';

export async function runInspect(): Promise<string> {
  const runtime = await createRuntimeService();
  return printInspect(runtime.inspect());
}
