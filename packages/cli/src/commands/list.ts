import { consumeOption } from '../cli/commandOptions.js';
import { printJson } from '../format/printJson.js';
import { printTable } from '../format/printTable.js';
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

  if (value === 'process') {
    return 'process';
  }

  if (value === 'env') {
    return 'env';
  }

  if (value === 'public') {
    return 'public';
  }

  return value as ListNamespace;
}

export async function runList(args: string[] = [], options: RuntimeServiceOptions = {}): Promise<string> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const namespace = normalizeNamespace(args[0] ?? consumeOption(cliArgs, '--namespace'));
  const prefix = consumeOption(cliArgs, '--prefix');
  const framework = consumeOption(cliArgs, '--framework');
  const vault = consumeOption(cliArgs, '--vault');
  const provider = consumeOption(cliArgs, '--provider');
  const entries = await listConfigEntries(namespace, {
    ...options,
    cliArgs,
    ...(prefix ? { prefix } : {}),
    ...(framework ? { framework } : {}),
    ...(vault ? { vault } : {}),
    ...(provider ? { provider } : {}),
  });

  if (options.json) {
    return printJson(entries);
  }

  if (entries.length === 0) {
    return '';
  }

  if (namespace === 'secret') {
    return printTable(
      entries.map((entry) => ({
        key: entry.key,
        value: printValue(entry.value),
        vault: entry.vault ?? 'default',
        provider: entry.provider ?? 'local',
      })),
    );
  }

  return entries
    .map((entry) => `${entry.key}=${printValue(entry.value)}${entry.derived ? '  (derived)' : ''}`)
    .join('\n');
}
