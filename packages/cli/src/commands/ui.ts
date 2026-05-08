import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';

import type { InspectResult } from '@kitsy/cnos';
import { loadManifest } from '@kitsy/cnos/internal';

import { consumeOption } from '../cli/commandOptions.js';
import { maskSecretValue } from '../format/maskSecret.js';
import { printJson } from '../format/printJson.js';
import { listConfigEntries, type ListNamespace } from '../services/listing.js';
import { listProfiles } from '../services/profiles.js';
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

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
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

function toRuntimeOptionsFromQuery(
  baseOptions: RuntimeServiceOptions,
  searchParams: URLSearchParams,
): RuntimeServiceOptions {
  const workspace = searchParams.get('workspace')?.trim();
  const profile = searchParams.get('profile')?.trim();

  return {
    ...baseOptions,
    ...(workspace ? { workspace } : {}),
    ...(profile ? { profile } : {}),
  };
}

function toRuntimeOptionsFromBody(
  baseOptions: RuntimeServiceOptions,
  body: Record<string, unknown>,
): RuntimeServiceOptions {
  const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : '';
  const profile = typeof body.profile === 'string' ? body.profile.trim() : '';

  return {
    ...baseOptions,
    ...(workspace ? { workspace } : {}),
    ...(profile ? { profile } : {}),
  };
}

function withUiPassphrase(
  processEnv: Record<string, string | undefined> | undefined,
  passphrase: string | undefined,
): Record<string, string | undefined> | undefined {
  if (!passphrase?.trim()) {
    return processEnv;
  }

  return {
    ...(processEnv ?? process.env),
    CNOS_SECRET_PASSPHRASE: passphrase.trim(),
  };
}

async function handleSummary(options: RuntimeServiceOptions, searchParams: URLSearchParams): Promise<Record<string, unknown>> {
  const runtimeOptions = toRuntimeOptionsFromQuery(options, searchParams);
  const runtime = await createRuntimeService({
    ...runtimeOptions,
    secretResolution: 'lazy',
  });
  const loadedManifest = await loadManifest({
    ...(options.root ? { root: options.root } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  });
  const declaredWorkspaces = Object.keys(loadedManifest.manifest.workspaces.items);
  const workspaces =
    declaredWorkspaces.length > 0
      ? declaredWorkspaces.sort((left, right) => left.localeCompare(right))
      : ['base'];
  const profiles = await listProfiles(loadedManifest.consumerRoot);
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
    workspaces,
    profiles,
    runtimeNamespaces: Object.keys(runtime.manifest.runtimeNamespaces),
    vaults: Object.keys(runtime.manifest.vaults),
  };
}

async function handleRevealList(
  body: Record<string, unknown>,
  options: RuntimeServiceOptions,
): Promise<{ namespace: 'secret'; entries: Array<{ key: string; value: unknown; derived?: boolean }> }> {
  const prefix = typeof body.prefix === 'string' ? body.prefix.trim() : '';
  const passphrase = typeof body.passphrase === 'string' ? body.passphrase : undefined;
  const runtimeOptions = toRuntimeOptionsFromBody(options, body);
  const runtime = await createRuntimeService({
    ...runtimeOptions,
    processEnv: withUiPassphrase(options.processEnv, passphrase),
    secretResolution: 'lazy',
  });
  const entries: Array<{ key: string; value: unknown; derived?: boolean }> = [];

  for (const entry of Array.from(runtime.graph.entries.values())
    .filter((candidate) => candidate.namespace === 'secret')
    .filter((candidate) => {
      if (!prefix) {
        return true;
      }

      return candidate.key.startsWith(prefix) || candidate.key.split('.').slice(1).join('.').startsWith(prefix);
    })
    .sort((left, right) => left.key.localeCompare(right.key))) {
    await runtime.refreshSecret(entry.key);
    entries.push({
      key: entry.key,
      value: runtime.read(entry.key),
      ...(typeof entry.winner.value === 'object' &&
      entry.winner.value !== null &&
      !Array.isArray(entry.winner.value) &&
      '$derive' in entry.winner.value
        ? { derived: true }
        : {}),
    });
  }

  return {
    namespace: 'secret',
    entries,
  };
}

async function handleRevealInspect(
  body: Record<string, unknown>,
  options: RuntimeServiceOptions,
): Promise<InspectResult> {
  const key = typeof body.key === 'string' ? body.key.trim() : '';

  if (!key) {
    throw new Error('Missing key');
  }

  const passphrase = typeof body.passphrase === 'string' ? body.passphrase : undefined;
  const runtimeOptions = toRuntimeOptionsFromBody(options, body);
  const runtime = await createRuntimeService({
    ...runtimeOptions,
    processEnv: withUiPassphrase(options.processEnv, passphrase),
    ...(key.startsWith('secret.') ? { secretResolution: 'lazy' as const } : {}),
  });

  if (key.startsWith('secret.')) {
    await runtime.refreshSecret(key);
  }

  return runtime.inspect(key);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: RuntimeServiceOptions,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (request.method === 'GET' && url.pathname === '/api/health') {
    writeJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/summary') {
    writeJson(response, 200, await handleSummary(options, url.searchParams));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/list') {
    const namespace = (url.searchParams.get('namespace') ?? 'value') as ListNamespace;
    const prefix = url.searchParams.get('prefix') ?? undefined;
    const runtimeOptions = toRuntimeOptionsFromQuery(options, url.searchParams);
    const entries = await listConfigEntries(namespace, {
      ...runtimeOptions,
      ...(prefix ? { prefix } : {}),
      ...(namespace === 'secret' ? { secretResolution: 'lazy' as const } : {}),
    });
    writeJson(response, 200, {
      namespace,
      entries: entries.map((entry) => maskListEntry(entry)),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/inspect') {
    const key = url.searchParams.get('key');

    if (!key) {
      writeJson(response, 400, { error: 'Missing key query parameter' });
      return;
    }

    const runtimeOptions = toRuntimeOptionsFromQuery(options, url.searchParams);
    const runtime = await createRuntimeService({
      ...runtimeOptions,
      ...(key.startsWith('secret.') ? { secretResolution: 'lazy' as const } : {}),
    });
    writeJson(response, 200, maskInspectResult(key, runtime.inspect(key)));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/reveal/list') {
    const body = await readJsonBody(request);
    writeJson(response, 200, await handleRevealList(body, options));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/reveal/inspect') {
    const body = await readJsonBody(request);
    writeJson(response, 200, await handleRevealInspect(body, options));
    return;
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    writeJson(response, 405, { error: 'Method not allowed' });
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
