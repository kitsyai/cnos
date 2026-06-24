import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SecretVaultProviderFactory, VaultAuthConfig } from '@kitsy/cnos-core';
import { createCnos } from '../src/createCnos.js';
import {
  CNOS_GRAPH_ENV_VAR,
  CNOS_PROJECTION_ENV_VAR,
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
  delete process.env.PORT;
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.TEST_REMOTE_TOKEN;
});

afterEach(async () => {
  process.chdir(originalCwd);
  delete process.env[CNOS_GRAPH_ENV_VAR];
  delete process.env[CNOS_PROJECTION_ENV_VAR];
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
