import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';

import type { InspectResult } from '@kitsy/cnos';

import { consumeOption } from '../cli/commandOptions.js';
import { maskSecretValue } from '../format/maskSecret.js';
import { printJson } from '../format/printJson.js';
import { listConfigEntries, type ListNamespace } from '../services/listing.js';
import { createRuntimeService, type RuntimeServiceOptions } from '../services/runtime.js';
import { spawnCommand } from '../services/spawn.js';

function parsePort(value: string | undefined, fallback: number, flag: string): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid value for ${flag}: ${value}`);
  }

  return parsed;
}

function resolveUiPackageRoot(): string {
  const require = createRequire(import.meta.url);

  try {
    const packageJsonPath = require.resolve('@kitsy/cnos-ui/package.json');
    return path.dirname(packageJsonPath);
  } catch {
    throw new Error('Unable to resolve @kitsy/cnos-ui. Install workspace dependencies before running `cnos ui`.');
  }
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${printJson(payload)}\n`);
}

function maskInspectResult(key: string, value: InspectResult): InspectResult {
  if (!key.startsWith('secret.')) {
    return value;
  }

  return {
    ...value,
    value: maskSecretValue(value.value),
    overridden: value.overridden.map((entry) => ({
      ...entry,
      value: maskSecretValue(entry.value),
    })),
  };
}

function maskListEntry(entry: { key: string; value: unknown; derived?: boolean }) {
  if (!entry.key.startsWith('secret.')) {
    return entry;
  }

  return {
    ...entry,
    value: maskSecretValue(entry.value),
  };
}

async function handleSummary(options: RuntimeServiceOptions): Promise<Record<string, unknown>> {
  const runtime = await createRuntimeService({
    ...options,
    secretResolution: 'lazy',
  });
  const envEntries = runtime.toEnv();
  const publicEntries = runtime.toPublicEnv();
  const counts = Array.from(runtime.graph.entries.values()).reduce<Record<string, number>>((acc, entry) => {
    acc.all += 1;
    acc[entry.namespace] = (acc[entry.namespace] ?? 0) + 1;
    return acc;
  }, { all: 0 });

  return {
    project: runtime.manifest.project.name,
    workspace: runtime.graph.workspace.workspaceId,
    workspaceSource: runtime.graph.workspace.workspaceSource,
    workspaceChain: runtime.graph.workspace.workspaceChain,
    profile: runtime.graph.profile,
    profileSource: runtime.graph.profileSource,
    counts: {
      ...counts,
      env: Object.keys(envEntries).length,
      public: Object.keys(publicEntries).length,
    },
    envMapping: Object.entries(runtime.manifest.envMapping.explicit).map(([envVar, logicalKey]) => ({
      envVar,
      logicalKey,
      secret: runtime.graph.entries.get(logicalKey)?.namespace === 'secret',
    })),
    promoted: runtime.manifest.public.promote,
    workspaces: Object.keys(runtime.manifest.workspaces.items),
    runtimeNamespaces: Object.keys(runtime.manifest.runtimeNamespaces),
    vaults: Object.keys(runtime.manifest.vaults),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: RuntimeServiceOptions,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (request.method !== 'GET') {
    writeJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  if (url.pathname === '/api/health') {
    writeJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/summary') {
    writeJson(response, 200, await handleSummary(options));
    return;
  }

  if (url.pathname === '/api/list') {
    const namespace = (url.searchParams.get('namespace') ?? 'value') as ListNamespace;
    const prefix = url.searchParams.get('prefix') ?? undefined;
    const entries = await listConfigEntries(namespace, {
      ...options,
      ...(prefix ? { prefix } : {}),
      ...(namespace === 'secret' ? { secretResolution: 'lazy' as const } : {}),
    });
    writeJson(response, 200, {
      namespace,
      entries: entries.map((entry) => maskListEntry(entry)),
    });
    return;
  }

  if (url.pathname === '/api/inspect') {
    const key = url.searchParams.get('key');

    if (!key) {
      writeJson(response, 400, { error: 'Missing key query parameter' });
      return;
    }

    const runtime = await createRuntimeService({
      ...options,
      ...(key.startsWith('secret.') ? { secretResolution: 'lazy' as const } : {}),
    });
    writeJson(response, 200, maskInspectResult(key, runtime.inspect(key)));
    return;
  }

  writeJson(response, 404, { error: 'Not found' });
}

function resolveUiUrl(host: string, port: number): string {
  if (host === '0.0.0.0' || host === '::') {
    return `http://127.0.0.1:${port}`;
  }

  return `http://${host}:${port}`;
}

export async function runUi(options: RuntimeServiceOptions = {}): Promise<void> {
  const cliArgs = [...(options.cliArgs ?? [])];
  const host = consumeOption(cliArgs, '--host') ?? '127.0.0.1';
  const port = parsePort(consumeOption(cliArgs, '--port'), 4310, '--port');
  const apiPort = parsePort(consumeOption(cliArgs, '--api-port'), 4311, '--api-port');

  if (cliArgs.length > 0) {
    throw new Error(`Unsupported ui arguments: ${cliArgs.join(' ')}`);
  }

  const uiRoot = resolveUiPackageRoot();
  const apiServer = createServer((request, response) => {
    void handleRequest(request, response, options).catch((error: unknown) => {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    apiServer.once('error', reject);
    apiServer.listen(apiPort, '127.0.0.1', () => resolve());
  });

  const uiProcess = spawnCommand(
    ['pnpm', 'exec', 'vite', '--host', host, '--port', String(port)],
    {
      cwd: uiRoot,
      env: {
        ...process.env,
        ...options.processEnv,
        CNOS_UI_API_TARGET: `http://127.0.0.1:${apiPort}`,
      },
      stdio: 'inherit',
    },
  );
  const uiUrl = resolveUiUrl(host, port);
  const apiAddress = apiServer.address() as AddressInfo | null;

  console.log(`CNOS UI running at ${uiUrl}`);
  console.log(`CNOS UI API running at http://127.0.0.1:${apiAddress?.port ?? apiPort}`);

  const shutdown = () => {
    apiServer.close();

    if (!uiProcess.killed) {
      uiProcess.kill('SIGTERM');
    }
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await new Promise<void>((resolve, reject) => {
      uiProcess.once('error', reject);
      uiProcess.once('exit', () => resolve());
    });
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    apiServer.close();
  }
}
