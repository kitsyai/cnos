import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCnos,
  type ConfigEntry,
  type DocumentSchemaDefinition,
  type LoaderPlugin,
} from '@kitsy/cnos-core';
import { startTestVarServer, type TestVarServer } from '@kitsy/cnos-var-testkit';
import { staticBearerAuthorize } from '@kitsy/cnos-var-server';

import { httpVarSourceProvider } from '../src/index.js';

const AGENTIC_SCHEMA: DocumentSchemaDefinition = {
  fields: {
    enabled: { type: 'boolean', required: true },
    model_target_ref: { type: 'string', required: true },
  },
  additionalProperties: false,
};

const documents = { 'agentic-lanes/v1': AGENTIC_SCHEMA };

const roots: string[] = [];
const servers: TestVarServer[] = [];

async function fixture(url: string, extra: string[] = []): Promise<string> {
  const manifest = [
    'version: 1',
    'project:',
    '  name: var-http-app',
    'varSources:',
    `  svc: { transport: http, url: "${url}", pollInterval: 60ms }`,
    'vars:',
    '  flags: { source: svc, mode: prefetch }',
    '  agentic: { source: svc, mode: prefetch, lease: 120ms }',
    '  user: { source: svc, mode: ondemand }',
    'documents:',
    '  agentic-lanes/v1:',
    '    fields:',
    '      enabled: { type: boolean, required: true }',
    '      model_target_ref: { type: string, required: true }',
    '    additionalProperties: false',
    'schema:',
    '  var.flags.enabled: { type: boolean, default: false }',
    '  var.agentic.lanes.vinci: { document: agentic-lanes/v1, required: true }',
    '  var.user.IN.coupon: { type: boolean, default: false }',
    ...extra,
    '',
  ].join('\n');

  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-varhttp-'));
  await mkdir(path.join(root, 'cnos'), { recursive: true });
  await writeFile(path.join(root, 'cnos', 'cnos.yml'), manifest);
  roots.push(root);
  return root;
}

function loader(entries: Array<{ key: string; value: unknown }>): LoaderPlugin {
  const configEntries: ConfigEntry[] = entries.map((entry) => ({
    key: entry.key,
    value: entry.value,
    namespace: entry.key.split('.')[0] ?? 'value',
    sourceId: 'fixture',
    pluginId: 'fixture',
    workspaceId: 'var-http-app',
  }));
  return { id: 'fixture', kind: 'loader', async load() { return configEntries; } };
}

async function activate(server: TestVarServer, scope: string, document: unknown, expectedGeneration = 0): Promise<void> {
  const created = await server.engine.createRevision({ scope, document });
  await server.engine.activate({ scope, revision: created.revision, expectedGeneration });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('var http runtime integration', () => {
  it('#1 falls back to static/default when the source has no runtime head (404 no-head)', async () => {
    const server = await startTestVarServer({ documents });
    servers.push(server);
    const root = await fixture(server.url);

    const runtime = await createCnos({
      root,
      plugins: [loader([{ key: 'value.flags.enabled', value: true }])],
      varSourceProviders: [httpVarSourceProvider],
    });

    // No head on the server -> static value.* twin wins for flags.enabled.
    expect(runtime.read('var.flags.enabled')).toBe(true);
    // No static, no runtime -> schema default.
    expect(runtime.read('var.user.IN.coupon')).toBe(false);
    await runtime.close?.();
  });

  it('#9 prefetch refetches the active runtime head on boot (restart recovery)', async () => {
    const server = await startTestVarServer({ documents });
    servers.push(server);
    await activate(server, 'agentic', { 'lanes.vinci': { enabled: true, model_target_ref: 'runtime-ref' } });
    const root = await fixture(server.url);

    const runtime = await createCnos({ root, plugins: [], varSourceProviders: [httpVarSourceProvider] });

    // #3 the whole document appears atomically as one snapshot.
    expect(runtime.read('var.agentic.lanes.vinci')).toEqual({ enabled: true, model_target_ref: 'runtime-ref' });
    const snap = runtime.varSnapshot?.('agentic.lanes.vinci');
    expect(snap?.source).toBe('runtime');
    expect(snap?.generation).toBe(1);
    await runtime.close?.();
  });

  it('#2 an activation becomes visible to a running consumer via the poller (no restart)', async () => {
    const server = await startTestVarServer({ documents });
    servers.push(server);
    const root = await fixture(server.url);

    const runtime = await createCnos({ root, plugins: [], varSourceProviders: [httpVarSourceProvider] });
    expect(runtime.read('var.flags.enabled')).toBe(false); // default, no head yet

    await activate(server, 'flags', { enabled: true });

    // Poll interval is 60ms; give it a few cycles.
    for (let i = 0; i < 20 && runtime.read('var.flags.enabled') !== true; i += 1) {
      await delay(40);
    }
    expect(runtime.read('var.flags.enabled')).toBe(true);
    await runtime.close?.();
  });

  it('#10 serves last-known-good on network loss and surfaces the error in status', async () => {
    const server = await startTestVarServer({ documents });
    servers.push(server);
    await activate(server, 'agentic', { 'lanes.vinci': { enabled: true, model_target_ref: 'ref-1' } });
    const root = await fixture(server.url);

    const runtime = await createCnos({ root, plugins: [], varSourceProviders: [httpVarSourceProvider] });
    expect(runtime.read('var.agentic.lanes.vinci')).toEqual({ enabled: true, model_target_ref: 'ref-1' });

    // Kill the server; a refresh fails but the LKG snapshot is retained.
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await runtime.refreshVars?.();

    expect(runtime.read('var.agentic.lanes.vinci')).toEqual({ enabled: true, model_target_ref: 'ref-1' });
    const status = runtime.varStatus?.();
    expect(status?.agentic?.appliedGeneration).toBe(1);
    expect(status?.agentic?.lastError).toBeTruthy();
    await runtime.close?.();
  });

  it('#11 reports expired freshness once the lease window elapses', async () => {
    const server = await startTestVarServer({ documents });
    servers.push(server);
    await activate(server, 'agentic', { 'lanes.vinci': { enabled: true, model_target_ref: 'ref' } });
    const root = await fixture(server.url);

    const runtime = await createCnos({ root, plugins: [], varSourceProviders: [httpVarSourceProvider] });
    await runtime.close?.(); // stop the poller so it can't refresh the lease

    await delay(180); // lease is 120ms
    const snap = runtime.varSnapshot?.('agentic.lanes.vinci');
    expect(snap?.freshness).toBe('expired');
  });

  it('#13 authenticates with the secret-ref bearer token and never leaks it into status', async () => {
    const server = await startTestVarServer({ documents, authorize: staticBearerAuthorize('workload-token-xyz') });
    servers.push(server);
    await activate(server, 'flags', { enabled: true });

    const runtime = await createCnos({
      root: await fixtureWithAuth(server.url),
      plugins: [loader([{ key: 'secret.ops.token', value: 'workload-token-xyz' }])],
      varSourceProviders: [httpVarSourceProvider],
    });

    // The bearer token was resolved from secret.ops.token and accepted by the server.
    expect(runtime.read('var.flags.enabled')).toBe(true);
    expect(JSON.stringify(runtime.varStatus?.())).not.toContain('workload-token-xyz');
    await runtime.close?.();
  });

  it('#14 ondemand reads serve the fallback tier immediately and trigger exactly one deduped fetch', async () => {
    const server = await startTestVarServer({ documents });
    servers.push(server);
    await activate(server, 'user', { 'IN.coupon': true });
    let pulls = 0;
    const countingProvider = {
      transport: 'http' as const,
      create(def: Parameters<typeof httpVarSourceProvider.create>[0], ctx: Parameters<typeof httpVarSourceProvider.create>[1]) {
        const inner = httpVarSourceProvider.create(def, ctx);
        return {
          ...inner,
          async pull(scope: Parameters<typeof inner.pull>[0], known?: string) {
            if ((scope.group ?? scope.key) === 'user') {
              pulls += 1;
            }
            return inner.pull(scope, known);
          },
        };
      },
    };

    const root = await fixture(server.url);
    const runtime = await createCnos({ root, plugins: [], varSourceProviders: [countingProvider] });

    // First sync read serves the default (fetch is async), and triggers one background fetch.
    expect(runtime.read('var.user.IN.coupon')).toBe(false);
    runtime.read('var.user.IN.coupon');
    runtime.read('var.user.IN.coupon');

    for (let i = 0; i < 20 && runtime.read('var.user.IN.coupon') !== true; i += 1) {
      await delay(30);
    }
    expect(runtime.read('var.user.IN.coupon')).toBe(true);
    expect(pulls).toBe(1); // deduped: exactly one ondemand fetch for the key
    await runtime.close?.();
  });
});

async function fixtureWithAuth(url: string): Promise<string> {
  const manifest = [
    'version: 1',
    'project:',
    '  name: var-http-auth',
    'varSources:',
    `  svc: { transport: http, url: "${url}", auth: { bearer: secret.ops.token } }`,
    'vars:',
    '  flags: { source: svc, mode: prefetch }',
    'schema:',
    '  var.flags.enabled: { type: boolean, default: false }',
    '',
  ].join('\n');
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-varhttp-auth-'));
  await mkdir(path.join(root, 'cnos'), { recursive: true });
  await writeFile(path.join(root, 'cnos', 'cnos.yml'), manifest);
  roots.push(root);
  return root;
}
