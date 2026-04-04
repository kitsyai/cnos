import { consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import { printValue } from '../format/printValue.js';
import { listConfigEntries, type ListNamespace } from '../services/listing.js';
import type { RuntimeServiceOptions } from '../services/runtime.js';

function normalizeNamespace(value?: string): ListNamespace {
  if (!value || value === 'all') {
    return 'all';
  }

  if (value === 'values' || value === 'value') {
    return 'value';
  }

  if (value === 'secrets' || value === 'secret') {
    return 'secret';
  }

  if (value === 'meta') {
    return 'meta';
  }

  throw new Error(`Unsupported list namespace: ${value}`);
}

export async function runList(args: string[] = [], options: RuntimeServiceOptions = {}): Promise<string> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const namespace = normalizeNamespace(args[0] ?? consumeOption(cliArgs, '--namespace'));
  const prefix = consumeOption(cliArgs, '--prefix');
  const entries = await listConfigEntries(namespace, {
    ...options,
    cliArgs,
    ...(prefix ? { prefix } : {}),
  });

  if (options.json) {
    return printJson(entries);
  }

  return entries.map((entry) => `${entry.key}=${printValue(entry.value)}`).join('\n');
}
