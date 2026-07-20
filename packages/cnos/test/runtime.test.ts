import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SecretVaultProviderFactory, VaultAuthConfig } from '@kitsy/cnos-core';
import { createCnos } from '../src/createCnos.js';
import {
  CNOS_GRAPH_ENV_VAR,
  CNOS_PROJECTION_ENV_VAR,
  CNOS_REQUIRE_SERVER_PROJECTION_ENV_VAR,
  CNOS_SERVER_PROJECTION_PATH_ENV_VAR,
  serializeRuntimeGraph,
  serializeServerProjection,
} from '../src/runtime/bootstrap.js';

const fixtureRoots: string[] = [];
const originalCwd = process.cwd();

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-singleton-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'values'), { recursive: true });
  await writeFile(path.join(root, '.cnosrc.yml'), 'root: ./.cnos\n');
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: runtime-fixture',
      'envMapping:',
      '  explicit:',
      '    PORT: value.server.port',
      'namespaces:',
      '  runtime:',
      '    request:',
      '      description: Request context',
      '      server_only: true',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'values', 'app.yml'),
    [
      'server:',
      '  port: 3000',
      'app:',
      '  effectivePort:',
      '    $derive:',
      "      expr: \"coalesce(process.env.PORT, value.server.port, '3000')\"",
      '  currentHost:',
      '    $derive:',
      "      expr: \"coalesce(request.headers.host, 'kitsy.local')\"",
    ].join('\n'),
  );
  return root;
}

async function createEnvSecretFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-projection-secret-'));
  fixtureRoots.push(root);
  await mkdir(path.join(root, '.cnos', 'secrets'), { recursive: true });
  await writeFile(path.join(root, '.cnosrc.yml'), 'root: ./.cnos\n');
  await writeFile(
    path.join(root, '.cnos', 'cnos.yml'),
    [
      'version: 1',
      'project:',
      '  name: projection-secret-fixture',
      'vaults:',
      '  firebase-stage:',
      '    provider: environment',
      '    mapping:',
      '      RAZORPAY_KEY_ID: subscriptions.razorpay.key_id',
    ].join('\n'),
  );
  await writeFile(
    path.join(root, '.cnos', 'secrets', 'subscriptions.yml'),
    [
      'subscriptions:',
      '  razorpay:',
      '    key_id:',
      '      provider: environment',
      '      ref: subscriptions.razorpay.key_id',
      '      vault: firebase-stage',
    ].join('\n'),
  );
  return root;
}

beforeEach(() => {
  delete process.env[CNOS_GRAPH_ENV_VAR];
  delete process.env[CNOS_PROJECTION_ENV_VAR];
  delete process.env[CNOS_SERVER_PROJECTION_PATH_ENV_VAR];
  delete process.env[CNOS_REQUIRE_SERVER_PROJECTION_ENV_VAR];
  delete process.env.PORT;
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.TEST_REMOTE_TOKEN;
});

afterEach(async () => {
  process.chdir(originalCwd);
  delete process.env[CNOS_GRAPH_ENV_VAR];
  delete process.env[CNOS_PROJECTION_ENV_VAR];
  delete process.env[CNOS_SERVER_PROJECTION_PATH_ENV_VAR];
  delete process.env[CNOS_REQUIRE_SERVER_PROJECTION_ENV_VAR];
  delete process.env.PORT;
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.TEST_REMOTE_TOKEN;
  vi.resetModules();
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createProjectedRemoteSecretFixture(): {
  projection: ReturnType<typeof createRemoteServerProjection>;
  authCalls: VaultAuthConfig[];
  batchCalls: string[][];
  getCalls: string[];
  providerFactory: SecretVaultProviderFactory;
} {
  const authCalls: VaultAuthConfig[] = [];
  const batchCalls: string[][] = [];
  const getCalls: string[] = [];
  const providerFactory: SecretVaultProviderFactory = {
    provider: 'test-remote',
    create(vaultId, definition) {
      return {
        vaultId,
        definition,
        async authenticate(authConfig) {
          authCalls.push(authConfig);
        },
        isAuthenticated() {
          return authCalls.length > 0;
        },
        async batchGet(refs) {
          batchCalls.push([...refs]);
          return new Map(refs.map((ref) => [ref, `projected:${ref}`]));
        },
        async get(ref) {
          getCalls.push(ref);
          return `projected:${ref}`;
        },
        async set() {
          throw new Error('test provider is read-only');
        },
        async delete() {
          throw new Error('test provider is read-only');
        },
        async list() {
          return ['db.password'];
        },
      };
    },
  };

  return {
    projection: createRemoteServerProjection(),
    authCalls,
    batchCalls,
    getCalls,
    providerFactory,
  };
}

function createRemoteServerProjection() {
  return {
    version: 1 as const,
    workspace: 'api',
    profile: 'stage',
    resolvedAt: '2026-06-11T00:00:00.000Z',
    configHash: 'hash',
    values: {},
    derived: {},
    secretRefs: {
      'db.password': {
        provider: 'test-remote',
        vault: 'remote-prod',
        ref: 'db.password',
      },
      'api.token': {
        provider: 'test-remote',
        vault: 'remote-prod',
        ref: 'api.token',
      },
    },
    vaults: {
      'remote-prod': {
        provider: 'test-remote',
        auth: {
          method: 'token' as const,
          token: {
            from: ['env:TEST_REMOTE_TOKEN'],
          },
          config: {
            address: 'https://vault.local',
          },
        },
      },
    },
    publicKeys: [],
    runtimeNamespaces: [],
    meta: {
      workspace: 'api',
      profile: 'stage',
      cnos_version: '1.10.0',
    },
  };
}

describe('@kitsy/cnos root runtime entry', () => {
  it('reads synchronously when bootstrapped from __CNOS_GRAPH__', async () => {
    const root = await createFixtureRoot();
    const runtime = await createCnos({
      root,
      processEnv: {},
    });

    process.env[CNOS_GRAPH_ENV_VAR] = serializeRuntimeGraph(runtime.graph);
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    expect(cnos('value.server.port')).toBe(3000);
    expect(cnos.value('server.port')).toBe(3000);
    expect(cnos.meta('profile')).toBe('base');
  });

  it('throws a clear error before ready() when no bootstrap payload exists', async () => {
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    expect(() => cnos.read('value.server.port')).toThrow(
      'CNOS not initialized. Call await cnos.ready() or use cnos run.',
    );
  });

  it('resolves standalone mode through ready()', async () => {
    const root = await createFixtureRoot();
    process.chdir(root);
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cnos.ready();

    expect(cnos.require('value.server.port')).toBe(3000);
    expect(cnos.value('server.port')).toBe(3000);
    expect(cnos.inspect('value.server.port').value).toBe(3000);
    expect(cnos.toNamespace('value')).toMatchObject({
      server: {
        port: 3000,
      },
    });
    expect(cnos.toEnv()).toEqual({
      PORT: '3000',
    });
    expect(cnos.format('Starting server at ${value.server.port}')).toBe('Starting server at 3000');
    expect(cnos.log('Starting server at ${value.server.port}')).toBe('Starting server at 3000');
    expect(consoleSpy).toHaveBeenCalledWith('Starting server at 3000');

    consoleSpy.mockRestore();
  });

  it('reads synchronously when bootstrapped from __CNOS_PROJECTION__', async () => {
    const root = await createFixtureRoot();
    const runtime = await createCnos({
      root,
      processEnv: {},
    });

    process.env[CNOS_PROJECTION_ENV_VAR] = serializeServerProjection(runtime.toServerProjection());
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    expect(cnos('value.server.port')).toBe(3000);
    expect(cnos.value('server.port')).toBe(3000);
    expect(cnos.meta('profile')).toBe('base');
  });

  it('consumes the projection var `schema` block after projection bootstrap (default tier + ingest validation)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-var-boot-'));
    fixtureRoots.push(root);
    await mkdir(path.join(root, 'cnos', 'secrets'), { recursive: true });
    process.env.OPS_VERIFY = 'var-boot-push-secret';
    await writeFile(
      path.join(root, 'cnos', 'secrets', 'ops.yml'),
      ['ops:', '  verify:', '    provider: environment', '    ref: ops.verify', '    vault: ops'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'cnos.yml'),
      [
        'version: 1',
        'project:',
        '  name: var-boot',
        'vaults:',
        '  ops:',
        '    provider: environment',
        '    mapping:',
        '      OPS_VERIFY: ops.verify',
        // The receiver fails CLOSED without a `verify` secret (W5d/D4), so declare one.
        'varSources:',
        '  svc: { transport: http, url: "http://unused.local", verify: secret.ops.verify }',
        'vars:',
        '  agentic: { source: svc, mode: ondemand }',
        '  user: { source: svc, mode: ondemand }',
        'documents:',
        '  agentic-lanes/v1:',
        '    fields:',
        '      enabled: { type: boolean, required: true }',
        '    additionalProperties: false',
        'schema:',
        '  var.agentic.lanes.vinci: { document: agentic-lanes/v1 }',
        '  var.user.IN.coupon_allowed: { type: boolean, default: false }',
        '',
      ].join('\n'),
    );

    const authoring = await createCnos({ root, processEnv: {} });
    const projection = authoring.toServerProjection();
    // The projection actually carries the var schema block (decision 2).
    expect(projection.schema?.['var.user.IN.coupon_allowed']).toEqual({ type: 'boolean', default: false });
    await authoring.close?.();

    process.env[CNOS_PROJECTION_ENV_VAR] = serializeServerProjection(projection);
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');
    const { varReceiver } = await import('../src/varReceiver.js');

    // Default tier resolves from the projection schema — previously blocked (schema was empty).
    expect(cnos.var?.('user.IN.coupon_allowed')).toBe(false);

    // Ingest validation now works from a projection bootstrap: route authenticated pushes
    // through the receiver and assert the schema rejects an invalid document (422) while
    // accepting a valid one (204).
    const handler = varReceiver('svc');
    const post = async (body: unknown, authenticated = true): Promise<number> => {
      let status = 0;
      const res = {
        headersSent: false,
        writeHead(code: number) {
          status = code;
          this.headersSent = true;
          return this;
        },
        end() {
          /* noop */
        },
      };
      handler(
        {
          method: 'POST',
          url: '/cnos/vars/agentic',
          headers: authenticated ? { authorization: `Bearer ${process.env.OPS_VERIFY}` } : {},
          body,
        } as never,
        res as never,
      );
      for (let i = 0; i < 50 && status === 0; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return status;
    };

    expect(await post({ values: { 'agentic.lanes.vinci': { enabled: 'not-a-boolean' } } })).toBe(422);
    expect(await post({ values: { 'agentic.lanes.vinci': { enabled: true } } })).toBe(204);
    expect(cnos.var?.('agentic.lanes.vinci')).toEqual({ enabled: true });

    // W5d/D4: the same receiver rejects an unauthenticated push outright.
    expect(await post({ values: { 'agentic.lanes.vinci': { enabled: false } } }, false)).toBe(401);

    await cnos.close?.();
    delete process.env.OPS_VERIFY;
  });

  it('autoloads from .cnos-server.json before full authoring resolution', async () => {
    const root = await createFixtureRoot();
    const runtime = await createCnos({
      root,
      processEnv: {},
    });
    await writeFile(
      path.join(root, '.cnos-server.json'),
      serializeServerProjection(runtime.toServerProjection()),
      'utf8',
    );
    process.chdir(root);
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    expect(cnos.value('server.port')).toBe(3000);
  });

  it('autoloads from .cnos-server.json from a nested next runtime path', async () => {
    const root = await createFixtureRoot();
    const runtime = await createCnos({
      root,
      processEnv: {},
    });
    const nestedNextPath = path.join(root, '.next', 'standalone', 'apps', 'web');
    await mkdir(nestedNextPath, { recursive: true });
    await writeFile(
      path.join(root, '.cnos-server.json'),
      serializeServerProjection(runtime.toServerProjection()),
      'utf8',
    );

    process.chdir(nestedNextPath);
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    expect(cnos.value('server.port')).toBe(3000);
  });

  it('autoloads from an explicit CNOS_SERVER_PROJECTION_PATH', async () => {
    const root = await createFixtureRoot();
    const runtime = await createCnos({
      root,
      processEnv: {},
    });

    const projectionRoot = path.join(root, '.next', 'standalone', 'apps', 'web');
    await mkdir(projectionRoot, { recursive: true });
    const projectionPath = path.join(projectionRoot, '.cnos-server.json');
    await writeFile(projectionPath, serializeServerProjection(runtime.toServerProjection()), 'utf8');

    process.chdir(root);
    process.env[CNOS_SERVER_PROJECTION_PATH_ENV_VAR] = projectionPath;
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    expect(cnos.value('server.port')).toBe(3000);
  });

  it('prefers __CNOS_PROJECTION__ over CNOS_SERVER_PROJECTION_PATH', async () => {
    const root = await createFixtureRoot();
    const runtime = await createCnos({
      root,
      processEnv: {},
    });
    const explicitProjection = serializeServerProjection(runtime.toServerProjection());
    const invalidProjectionPath = path.join(root, '.cnos-server.json');

    await writeFile(invalidProjectionPath, '{not-valid-json}', 'utf8');

    process.env[CNOS_SERVER_PROJECTION_PATH_ENV_VAR] = invalidProjectionPath;
    process.env[CNOS_PROJECTION_ENV_VAR] = explicitProjection;
    process.chdir(root);
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    expect(cnos.value('server.port')).toBe(3000);
  });

  it('fails when __CNOS_PROJECTION__ is invalid even if CNOS_SERVER_PROJECTION_PATH is valid', async () => {
    const root = await createFixtureRoot();
    const runtime = await createCnos({
      root,
      processEnv: {},
    });
    const projectionPath = path.join(root, '.cnos-server.json');
    await writeFile(projectionPath, serializeServerProjection(runtime.toServerProjection()), 'utf8');

    process.env[CNOS_SERVER_PROJECTION_PATH_ENV_VAR] = projectionPath;
    process.env[CNOS_PROJECTION_ENV_VAR] = '{not-valid-json}';
    process.chdir(root);
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    await expect(cnos.ready()).rejects.toThrow('CNOS server projection required but not found.');
    await expect(cnos.ready()).rejects.toThrow(/- __CNOS_PROJECTION__ error:/);
  });

  it('fails when __CNOS_GRAPH__ is invalid even if __CNOS_PROJECTION__ is valid', async () => {
    const root = await createFixtureRoot();
    const runtime = await createCnos({
      root,
      processEnv: {},
    });

    process.env[CNOS_GRAPH_ENV_VAR] = '{not-json';
    process.env[CNOS_PROJECTION_ENV_VAR] = serializeServerProjection(runtime.toServerProjection());
    process.chdir(root);
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    await expect(cnos.ready()).rejects.toThrow('CNOS server projection required but not found.');
    await expect(cnos.ready()).rejects.toThrow(/- __CNOS_GRAPH__ error:/);
  });

  it('throws a clear error when CNOS_REQUIRE_SERVER_PROJECTION is enabled and projection is missing', async () => {
    const root = await createFixtureRoot();
    process.chdir(root);
    process.env[CNOS_REQUIRE_SERVER_PROJECTION_ENV_VAR] = 'true';
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    await expect(cnos.ready()).rejects.toThrow(
      'CNOS server projection required but not found.',
    );
    await expect(cnos.ready()).rejects.toThrow(
      `- CNOS_SERVER_PROJECTION_PATH: not set`,
    );
    await expect(cnos.ready()).rejects.toThrow(`- ancestor discovery from ${process.cwd()}`);
  });

  it('throws when explicit CNOS_SERVER_PROJECTION_PATH is invalid even without CNOS_REQUIRE_SERVER_PROJECTION', async () => {
    const root = await createFixtureRoot();
    process.chdir(root);
    process.env[CNOS_SERVER_PROJECTION_PATH_ENV_VAR] = path.join(root, '.cnos-server.json');
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    await expect(cnos.ready()).rejects.toThrow('CNOS server projection required but not found.');
  });

  it('throws a clear error when an explicit CNOS_SERVER_PROJECTION_PATH cannot be read in required mode', async () => {
    const root = await createFixtureRoot();
    process.chdir(root);
    process.env[CNOS_SERVER_PROJECTION_PATH_ENV_VAR] = path.join(root, '.cnos-server.json');
    process.env[CNOS_REQUIRE_SERVER_PROJECTION_ENV_VAR] = '1';
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    await expect(cnos.ready()).rejects.toThrow(
      'CNOS server projection required but not found.',
    );
    await expect(cnos.ready()).rejects.toThrow(
      `- CNOS_SERVER_PROJECTION_PATH: ${path.join(root, '.cnos-server.json')}`,
    );
  });

  it('keeps runtime-dependent formulas live after projection bootstrap', async () => {
    const root = await createFixtureRoot();
    process.env.PORT = '4500';
    const runtime = await createCnos({
      root,
      processEnv: process.env,
    });

    process.env[CNOS_PROJECTION_ENV_VAR] = serializeServerProjection(runtime.toServerProjection());
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    expect(cnos.value('app.effectivePort')).toBe('4500');
    process.env.PORT = '4700';
    expect(cnos.value('app.effectivePort')).toBe('4700');

    let host = 'console.kitsy.local';
    cnos.registerRuntimeProvider('request', (key) => (key === 'headers.host' ? host : undefined));
    expect(cnos.value('app.currentHost')).toBe('console.kitsy.local');
    host = 'cnos.kitsy.local';
    expect(cnos.value('app.currentHost')).toBe('cnos.kitsy.local');
  });

  it('hydrates environment-backed secrets from server projections using mapped env vars', async () => {
    const root = await createEnvSecretFixtureRoot();
    process.env.RAZORPAY_KEY_ID = 'rzp_stage_live_key';
    const runtime = await createCnos({
      root,
      processEnv: process.env,
    });

    process.env[CNOS_PROJECTION_ENV_VAR] = serializeServerProjection(runtime.toServerProjection());
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    await cnos.ready();
    expect(cnos.secret('subscriptions.razorpay.key_id')).toBe('rzp_stage_live_key');
    delete process.env.RAZORPAY_KEY_ID;
  });

  it('hydrates projected remote vaults through ready() provider registration', async () => {
    const { projection, authCalls, batchCalls, getCalls, providerFactory } = createProjectedRemoteSecretFixture();
    process.env.TEST_REMOTE_TOKEN = 'projected-token';
    process.env[CNOS_PROJECTION_ENV_VAR] = serializeServerProjection(projection);
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    await cnos.ready({ secretVaultProviders: [providerFactory] });

    expect(cnos.secret('db.password')).toBe('projected:db.password');
    expect(cnos.secret('api.token')).toBe('projected:api.token');
    expect(authCalls).toEqual([
      {
        method: 'token',
        token: 'projected-token',
        config: {
          address: 'https://vault.local',
        },
      },
    ]);
    expect(batchCalls).toEqual([['api.token', 'db.password']]);
    expect(getCalls).toEqual([]);

    await cnos.refreshSecrets();
    expect(batchCalls).toEqual([
      ['api.token', 'db.password'],
      ['api.token', 'db.password'],
    ]);
    expect(getCalls).toEqual([]);
  });

  it('hydrates projected remote vaults through compiled-in singleton provider registration', async () => {
    const { projection, providerFactory } = createProjectedRemoteSecretFixture();
    process.env.TEST_REMOTE_TOKEN = 'projected-token';
    process.env[CNOS_PROJECTION_ENV_VAR] = serializeServerProjection(projection);
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    cnos.registerSecretVaultProvider(providerFactory);
    await cnos.ready();

    expect(cnos.secret('db.password')).toBe('projected:db.password');
  });

  it('hydrates loaded server projections with custom provider factories', async () => {
    const { projection, providerFactory } = createProjectedRemoteSecretFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-load-projection-'));
    fixtureRoots.push(root);
    const projectionPath = path.join(root, '.cnos-server.json');
    process.env.TEST_REMOTE_TOKEN = 'projected-token';
    vi.resetModules();
    await writeFile(projectionPath, serializeServerProjection(projection), 'utf8');

    const { default: cnos } = await import('../src/index.js');

    await cnos.loadProjection(projectionPath, { secretVaultProviders: [providerFactory] });
    await cnos.ready();

    expect(cnos.secret('db.password')).toBe('projected:db.password');
  });

  it('preserves registered runtime providers when ready() reattaches projected vault factories', async () => {
    const { projection: baseProjection, providerFactory } = createProjectedRemoteSecretFixture();
    const projection = {
      ...baseProjection,
      derived: {
        'value.currentTenant': {
          expr: 'request.tenant',
          deps: [],
          runtimeRefs: ['request.tenant'],
        },
      },
      runtimeNamespaces: ['request'],
    };
    process.env.TEST_REMOTE_TOKEN = 'projected-token';
    process.env[CNOS_PROJECTION_ENV_VAR] = serializeServerProjection(projection);
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    cnos.registerRuntimeProvider('request', (path) => (path === 'tenant' ? 'acme' : undefined));
    await cnos.ready({ secretVaultProviders: [providerFactory] });

    expect(cnos.value('currentTenant')).toBe('acme');
    expect(cnos.secret('db.password')).toBe('projected:db.password');
  });

  it('rejects projected secret refs that conflict with their named vault provider', async () => {
    const { projection: baseProjection, providerFactory } = createProjectedRemoteSecretFixture();
    const projection = {
      ...baseProjection,
      secretRefs: {
        'db.password': {
          provider: 'environment',
          vault: 'remote-prod',
          ref: 'db.password',
        },
      },
    };
    process.env.TEST_REMOTE_TOKEN = 'projected-token';
    process.env[CNOS_PROJECTION_ENV_VAR] = serializeServerProjection(projection);
    vi.resetModules();

    const { default: cnos } = await import('../src/index.js');

    await expect(cnos.ready({ secretVaultProviders: [providerFactory] })).rejects.toThrow(
      'Secret ref "secret.db.password" declares provider "environment" but vault "remote-prod" uses provider "test-remote"',
    );
  });
});
