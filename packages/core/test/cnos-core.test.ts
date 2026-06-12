import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applySchemaRules,
  createCnos,
  createDefaultRuntimeProviders,
  createDerivedRuntimeSupport,
  envVarToLogicalKey,
  expandProfileChain,
  expandWorkspaceChain,
  flattenObject,
  loadManifest,
  loadWorkspaceFile,
  logicalKeyToEnvVar,
  parseGitUri,
  resolveWorkspaceContext,
  resolveActiveProfile,
  validateEnvMappingCollisions,
  validatePublicSafety,
  validateWorkspaceSafety,
  type ConfigEntry,
  type LoaderPlugin,
  type SecretVaultProviderFactory,
  type VaultAuthConfig,
} from '../src/index.js';

const fixtureRoots: string[] = [];

async function createFixtureRoot(manifestSource: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-core-'));
  const cnosRoot = path.join(root, 'cnos');
  await mkdir(cnosRoot, { recursive: true });
  await writeFile(path.join(cnosRoot, 'cnos.yml'), manifestSource);
  fixtureRoots.push(root);
  return root;
}

async function runGit(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `git exited with ${code ?? 1}`));
    });
  });
}

async function createRemoteGitFixture(): Promise<{
  repoRoot: string;
  consumerRoot: string;
  rootUri: string;
  cacheDir: string;
}> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-remote-repo-'));
  const consumerRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-remote-consumer-'));
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'cnos-remote-cache-'));
  fixtureRoots.push(repoRoot, consumerRoot, cacheDir);
  await mkdir(path.join(repoRoot, '.cnos', 'workspaces', 'travel', 'values'), { recursive: true });
  await writeFile(
    path.join(repoRoot, '.cnos', 'cnos.yml'),
    ['version: 1', 'project:', '  name: remote-config', 'workspaces:', '  default: travel', '  items:', '    travel: {}'].join('\n'),
  );
  await writeFile(
    path.join(repoRoot, '.cnos', 'workspaces', 'travel', 'values', 'app.yml'),
    ['app:', '  name: remote-travel', 'server:', '  port: 7703'].join('\n'),
  );
  await runGit(['init'], repoRoot);
  await runGit(['config', 'user.email', 'cnos@example.com'], repoRoot);
  await runGit(['config', 'user.name', 'CNOS Test'], repoRoot);
  await runGit(['add', '.'], repoRoot);
  await runGit(['commit', '-m', 'init-remote-config'], repoRoot);
  await runGit(['branch', '-M', 'main'], repoRoot);
  const rootUri = `git+${pathToFileURL(repoRoot).href}#main:.cnos`;
  await writeFile(
    path.join(consumerRoot, '.cnosrc.yml'),
    ['root: ' + rootUri, 'workspace: travel'].join('\n'),
  );

  return {
    repoRoot,
    consumerRoot,
    rootUri,
    cacheDir,
  };
}

function createFixtureLoader(id: string, entries: ConfigEntry[]): LoaderPlugin {
  return {
    id,
    kind: 'loader',
    async load() {
      return entries;
    },
  };
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('@kitsy/cnos-core', () => {
  it('loads and normalizes a manifest from cnos/cnos.yml', async () => {
    const root = await createFixtureRoot('version: 1\nproject:\n  name: fixture\n');
    const loadedManifest = await loadManifest({ root });

    expect(loadedManifest.manifest.project.name).toBe('fixture');
    expect(loadedManifest.manifest.profiles.default).toBe('base');
    expect(loadedManifest.manifest.plugins.resolver).toBe('profile-aware');
    expect(loadedManifest.manifest.namespaces.public).toMatchObject({
      kind: 'projection',
      source: 'promote',
      shareable: true,
    });
    expect(loadedManifest.manifest.namespaces.env).toMatchObject({
      kind: 'projection',
      source: 'envMapping',
      shareable: true,
    });
    expect(loadedManifest.manifest.namespaces.process).toMatchObject({
      kind: 'system',
      shareable: false,
      readonly: true,
    });
    expect(loadedManifest.manifest.vaults).toEqual({});
  });

  it('rejects invalid manifests with a clear error', async () => {
    const root = await createFixtureRoot('version: 1\nproject: {}\n');

    await expect(loadManifest({ root })).rejects.toThrow('project.name');
  });

  it('parses git root URIs with refs and optional subpaths', () => {
    expect(parseGitUri('git+https://github.com/org/repo.git#v2.1.0')).toMatchObject({
      cloneUrl: 'https://github.com/org/repo.git',
      ref: 'v2.1.0',
      subpath: '.cnos',
      transport: 'https',
    });
    expect(parseGitUri('git+ssh://git@github.com/org/repo.git#main:config/.cnos')).toMatchObject({
      cloneUrl: 'ssh://git@github.com/org/repo.git',
      ref: 'main',
      subpath: 'config/.cnos',
      transport: 'ssh',
    });
    expect(() => parseGitUri('git+https://github.com/org/repo.git')).toThrow('#ref');
  });

  it('loads a manifest from a git-backed remote root referenced by .cnosrc.yml', async () => {
    const fixture = await createRemoteGitFixture();
    const env = {
      ...process.env,
      CNOS_CACHE_DIR: fixture.cacheDir,
    };
    const loadedManifest = await loadManifest({
      cwd: fixture.consumerRoot,
      processEnv: env,
    });

    expect(loadedManifest.manifest.project.name).toBe('remote-config');
    expect(loadedManifest.anchoredWorkspace).toBe('travel');
    expect(loadedManifest.rootResolution).toMatchObject({
      rootUri: fixture.rootUri,
      protocol: 'git',
      remote: true,
      readOnly: true,
      ref: 'main',
      subpath: '.cnos',
      immutable: false,
    });

    expect(loadedManifest.manifestRoot).toContain('repo');
  });

  it('normalizes manifest-defined vaults', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: fixture',
        'vaults:',
        '  local-dev:',
        '    provider: local',
        '    auth:',
        '      passphrase:',
        '        from:',
        '          - env:CNOS_SECRET_PASSPHRASE',
        '  github-ci:',
        '    provider: github-secrets',
      ].join('\n'),
    );
    const loadedManifest = await loadManifest({ root });

    expect(loadedManifest.manifest.vaults['local-dev']).toEqual({
      provider: 'local',
      auth: {
        method: 'passphrase',
        passphrase: {
          from: ['env:CNOS_SECRET_PASSPHRASE'],
        },
      },
    });
    expect(loadedManifest.manifest.vaults['github-ci']).toEqual({
      provider: 'github-secrets',
      auth: {
        method: 'environment',
      },
    });
  });

  it('creates a runtime with flat precedence, read helpers, and meta keys', async () => {
    const root = await createFixtureRoot(
      ['version: 1', 'project:', '  name: fixture', 'resolution:', '  precedence:', '    - seed-base', '    - seed-override'].join('\n'),
    );
    const baseLoader = createFixtureLoader('seed-base', [
      {
        key: 'value.app.config',
        value: {
          host: '127.0.0.1',
          port: 3000,
        },
        namespace: 'value',
        sourceId: 'seed-base',
        pluginId: 'seed-base',
        workspaceId: 'fixture',
      },
    ]);
    const overrideLoader = createFixtureLoader('seed-override', [
      {
        key: 'value.app.config',
        value: {
          port: 8080,
        },
        namespace: 'value',
        sourceId: 'seed-override',
        pluginId: 'seed-override',
        workspaceId: 'fixture',
      },
    ]);
    const runtime = await createCnos({
      root,
      plugins: [baseLoader, overrideLoader],
    });

    expect(runtime.read('value.app.config')).toEqual({
      host: '127.0.0.1',
      port: 8080,
    });
    expect(runtime.readOr('value.app.missing', 'fallback')).toBe('fallback');
    expect(() => runtime.require('value.app.missing')).toThrow('value.app.missing');
    expect(runtime.meta('profile')).toBe('base');
    expect(runtime.meta('resolved.from')).toBe('manifest-default');
    expect(runtime.meta('cnos.version')).toBeTruthy();
    expect(runtime.inspect('value.app.config').winner.sourceId).toBe('seed-override');
    expect(runtime.toNamespace('meta')).toMatchObject({
      profile: 'base',
      resolved: {
        from: 'manifest-default',
      },
    });
  });

  it('resolves config-only derived values and precomputes them for repeated reads', async () => {
    const root = await createFixtureRoot('version: 1\nproject:\n  name: derived-config\n');
    const loader = createFixtureLoader('derived-loader', [
      {
        key: 'value.app.protocol',
        value: 'https',
        namespace: 'value',
        sourceId: 'derived-loader',
        pluginId: 'derived-loader',
        workspaceId: 'derived-config',
      },
      {
        key: 'value.app.host',
        value: 'api.kitsy.ai',
        namespace: 'value',
        sourceId: 'derived-loader',
        pluginId: 'derived-loader',
        workspaceId: 'derived-config',
      },
      {
        key: 'value.app.port',
        value: 443,
        namespace: 'value',
        sourceId: 'derived-loader',
        pluginId: 'derived-loader',
        workspaceId: 'derived-config',
      },
      {
        key: 'value.app.origin',
        value: {
          $derive: '${value.app.protocol}://${value.app.host}:${value.app.port}',
        },
        namespace: 'value',
        sourceId: 'derived-loader',
        pluginId: 'derived-loader',
        workspaceId: 'derived-config',
      },
    ]);

    const runtime = await createCnos({
      root,
      plugins: [loader],
    });

    expect(runtime.value('app.origin')).toBe('https://api.kitsy.ai:443');
    expect(runtime.inspect('value.app.origin').derived).toMatchObject({
      type: 'template',
      runtimeDependent: false,
    });
    expect(runtime.inspect('value.app.origin').derived?.dependencies).toEqual([
      { key: 'value.app.host', value: 'api.kitsy.ai' },
      { key: 'value.app.port', value: 443 },
      { key: 'value.app.protocol', value: 'https' },
    ]);

    const support = createDerivedRuntimeSupport(
      runtime.graph,
      runtime.manifest,
      createDefaultRuntimeProviders(runtime.manifest, {}),
    );
    let baseReads = 0;
    const readBase = (key: string) => {
      baseReads += 1;
      return runtime.graph.entries.get(key)?.value;
    };

    expect(support.read('value.app.origin', readBase)).toBe('https://api.kitsy.ai:443');
    expect(support.read('value.app.origin', readBase)).toBe('https://api.kitsy.ai:443');
    expect(baseReads).toBe(0);
  });

  it('treats runtime-dependent derivations as live and keeps them in server projections', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: derived-runtime',
      ].join('\n'),
    );
    const loader = createFixtureLoader('runtime-loader', [
      {
        key: 'value.app.defaultHost',
        value: 'api.kitsy.ai',
        namespace: 'value',
        sourceId: 'runtime-loader',
        pluginId: 'runtime-loader',
        workspaceId: 'derived-runtime',
      },
      {
        key: 'value.app.publicHost',
        value: {
          $derive: {
            expr: "coalesce(process.env.PUBLIC_HOST, value.app.defaultHost)",
          },
        },
        namespace: 'value',
        sourceId: 'runtime-loader',
        pluginId: 'runtime-loader',
        workspaceId: 'derived-runtime',
      },
    ]);
    const env = {
      PUBLIC_HOST: 'stage.kitsy.dev',
    };
    const runtime = await createCnos({
      root,
      plugins: [loader],
      processEnv: env,
    });

    expect(runtime.value('app.publicHost')).toBe('stage.kitsy.dev');
    env.PUBLIC_HOST = 'prod.kitsy.ai';
    expect(runtime.value('app.publicHost')).toBe('prod.kitsy.ai');
    expect(runtime.inspect('value.app.publicHost').derived).toMatchObject({
      runtimeDependent: true,
      runtimeNamespaces: ['process'],
      promotionWarning: 'Cannot be promoted to browser/public.',
    });

    const projection = runtime.toServerProjection();

    expect(projection.values).toMatchObject({
      'app.defaultHost': 'api.kitsy.ai',
    });
    expect(projection.derived).toMatchObject({
      'app.publicHost': {
        expr: "coalesce(process.env.PUBLIC_HOST, value.app.defaultHost)",
        deps: ['value.app.defaultHost'],
        runtimeRefs: ['process.env.PUBLIC_HOST'],
      },
    });
    expect(projection.secretRefs).toEqual({});
    expect(projection.runtimeNamespaces).toEqual(['process']);
  });

  it('includes environment-backed env-var bindings in server projections', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: env-secret-projection',
        'vaults:',
        '  firebase-stage:',
        '    provider: environment',
        '    mapping:',
        '      RAZORPAY_KEY_ID: subscriptions.razorpay.key_id',
      ].join('\n'),
    );
    const loader = createFixtureLoader('env-secret-loader', [
      {
        key: 'secret.subscriptions.razorpay.key_id',
        value: {
          provider: 'environment',
          ref: 'subscriptions.razorpay.key_id',
          vault: 'firebase-stage',
        },
        namespace: 'secret',
        sourceId: 'filesystem-secrets',
        pluginId: '@kitsy/cnos/plugins/filesystem-secrets',
        workspaceId: 'default',
        metadata: {
          secretRef: {
            provider: 'environment',
            ref: 'subscriptions.razorpay.key_id',
            vault: 'firebase-stage',
          },
        },
      },
    ]);
    const runtime = await createCnos({
      root,
      plugins: [loader],
      processEnv: {},
    });

    const projection = runtime.toServerProjection();

    expect(projection.secretRefs).toEqual({
      'subscriptions.razorpay.key_id': {
        provider: 'environment',
        vault: 'firebase-stage',
        ref: 'subscriptions.razorpay.key_id',
        envVar: 'RAZORPAY_KEY_ID',
      },
    });
    expect(projection.vaults).toEqual({
      'firebase-stage': {
        provider: 'environment',
        auth: {
          method: 'environment',
        },
        mapping: {
          RAZORPAY_KEY_ID: 'subscriptions.razorpay.key_id',
        },
      },
    });
  });

  it('resolves secrets through custom vault provider factories', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: custom-vault-provider',
        'vaults:',
        '  remote-prod:',
        '    provider: test-remote',
        '    auth:',
        '      method: token',
        '      token:',
        '        from:',
        '          - env:TEST_REMOTE_TOKEN',
      '      config:',
      '        address: https://vault.local',
      '        clientSecret: should-not-project',
      '        nested:',
      '          privateKey: should-not-project',
      '          tenant: cnos',
    ].join('\n'),
    );
    const loader = createFixtureLoader('remote-secret-loader', [
      {
        key: 'secret.db.password',
        value: {
          ref: 'db.password',
          vault: 'remote-prod',
        },
        namespace: 'secret',
        sourceId: 'filesystem-secrets',
        pluginId: '@kitsy/cnos/plugins/filesystem-secrets',
        workspaceId: 'default',
      },
    ]);
    const authCalls: VaultAuthConfig[] = [];
    const batchCalls: string[][] = [];
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
            return new Map(refs.map((ref) => [ref, `resolved:${ref}`]));
          },
          async get(ref) {
            return `resolved:${ref}`;
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

    const runtime = await createCnos({
      root,
      plugins: [loader],
      processEnv: {
        TEST_REMOTE_TOKEN: 'provider-token',
      },
      secretVaultProviders: [providerFactory],
    });

    expect(runtime.secret('db.password')).toBe('resolved:db.password');
    expect(authCalls).toEqual([
      {
        method: 'token',
        token: 'provider-token',
        config: {
          address: 'https://vault.local',
          clientSecret: 'should-not-project',
          nested: {
            privateKey: 'should-not-project',
            tenant: 'cnos',
          },
        },
      },
    ]);
    expect(batchCalls).toEqual([['db.password']]);
    expect(runtime.toServerProjection().secretRefs['db.password']).toEqual({
      provider: 'test-remote',
      vault: 'remote-prod',
      ref: 'db.password',
    });
    expect(runtime.toServerProjection().vaults).toEqual({
      'remote-prod': {
        provider: 'test-remote',
        auth: {
          method: 'token',
          token: {
            from: ['env:TEST_REMOTE_TOKEN'],
          },
          config: {
            address: 'https://vault.local',
            nested: {
              tenant: 'cnos',
            },
          },
        },
      },
    });
  });

  it('uses explicit vault fallback providers when the primary provider is unavailable', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: custom-vault-fallback',
        'vaults:',
        '  remote-prod:',
        '    provider: test-remote',
        '    fallback:',
        '      - provider: environment',
        '        mapping:',
        '          DB_PASSWORD: db.password',
      ].join('\n'),
    );
    const loader = createFixtureLoader('fallback-secret-loader', [
      {
        key: 'secret.db.password',
        value: {
          ref: 'db.password',
          vault: 'remote-prod',
        },
        namespace: 'secret',
        sourceId: 'filesystem-secrets',
        pluginId: '@kitsy/cnos/plugins/filesystem-secrets',
        workspaceId: 'default',
      },
    ]);

    const runtime = await createCnos({
      root,
      plugins: [loader],
      processEnv: {
        DB_PASSWORD: 'fallback-secret',
      },
    });

    expect(runtime.secret('db.password')).toBe('fallback-secret');
    expect(runtime.toServerProjection().vaults?.['remote-prod']).toEqual({
      provider: 'test-remote',
      fallback: [
        {
          provider: 'environment',
          auth: {
            method: 'environment',
          },
          mapping: {
            DB_PASSWORD: 'db.password',
          },
        },
      ],
    });
  });

  it('rejects secret refs that conflict with their named vault provider during hydration', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: provider-conflict',
        'vaults:',
        '  remote-prod:',
        '    provider: test-remote',
      ].join('\n'),
    );
    const loader = createFixtureLoader('provider-conflict-secret-loader', [
      {
        key: 'secret.db.password',
        value: {
          provider: 'environment',
          ref: 'db.password',
          vault: 'remote-prod',
        },
        namespace: 'secret',
        sourceId: 'filesystem-secrets',
        pluginId: '@kitsy/cnos/plugins/filesystem-secrets',
        workspaceId: 'default',
      },
    ]);

    await expect(
      createCnos({
        root,
        plugins: [loader],
        processEnv: {
          'db.password': 'should-not-resolve',
        },
        secretResolution: 'eager',
      }),
    ).rejects.toThrow(
      'Secret ref "secret.db.password" declares provider "environment" but vault "remote-prod" uses provider "test-remote"',
    );
  });

  it('supports declared custom runtime namespaces through runtime providers', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: runtime-providers',
        'namespaces:',
        '  runtime:',
        '    request:',
        '      description: Request context',
        '      server_only: true',
      ].join('\n'),
    );
    const loader = createFixtureLoader('request-loader', [
      {
        key: 'value.app.defaultHost',
        value: 'fallback.kitsy.ai',
        namespace: 'value',
        sourceId: 'request-loader',
        pluginId: 'request-loader',
        workspaceId: 'runtime-providers',
      },
      {
        key: 'value.app.currentHost',
        value: {
          $derive: {
            expr: 'coalesce(request.headers.host, value.app.defaultHost)',
          },
        },
        namespace: 'value',
        sourceId: 'request-loader',
        pluginId: 'request-loader',
        workspaceId: 'runtime-providers',
      },
    ]);
    const requestContext: {
      host?: string;
    } = {};
    const runtime = await createCnos({
      root,
      plugins: [loader],
    });

    runtime.registerRuntimeProvider('request', (key) =>
      key === 'headers.host' ? requestContext.host : undefined,
    );

    expect(runtime.value('app.currentHost')).toBe('fallback.kitsy.ai');
    requestContext.host = 'live.kitsy.dev';
    expect(runtime.value('app.currentHost')).toBe('live.kitsy.dev');
  });

  it('does not freeze ambient process-env winners into server projections', async () => {
    const root = await createFixtureRoot([
      'version: 1',
      'project:',
      '  name: projection-filter',
      'profiles:',
      '  default: local',
    ].join('\n'));
    const loader: LoaderPlugin = createFixtureLoader('projection-filter-loader', [
      {
        key: 'value.app.name',
        value: 'from-process-env',
        namespace: 'value',
        sourceId: 'process-env',
        pluginId: '@kitsy/cnos/plugins/process-env',
        workspaceId: 'default',
        origin: { envVar: 'APP_NAME' },
      },
      {
        key: 'value.server.port',
        value: '8080',
        namespace: 'value',
        sourceId: 'filesystem-values',
        pluginId: '@kitsy/cnos/plugins/filesystem-values',
        workspaceId: 'default',
      },
    ]);
    const runtime = await createCnos({
      root,
      plugins: [loader],
      processEnv: {
        APP_NAME: 'from-process-env',
      },
    });

    expect(runtime.read('value.app.name')).toBe('from-process-env');
    expect(runtime.toServerProjection().values).toEqual({
      'server.port': '8080',
    });
  });

  it('flattens nested records', () => {
    expect(flattenObject({ app: { port: 3000 } })).toEqual({
      'app.port': 3000,
    });
  });

  it('maps env names bidirectionally with convention and explicit overrides', () => {
    const mapping = {
      convention: 'SCREAMING_SNAKE' as const,
      explicit: {
        DATABASE_HOST: 'value.inventory.db.host',
        DATABASE_PASSWORD: 'secret.inventory.db.password',
      },
    };

    expect(logicalKeyToEnvVar('value.server.port', mapping)).toBe('SERVER_PORT');
    expect(logicalKeyToEnvVar('secret.inventory.db.password', mapping)).toBe('DATABASE_PASSWORD');
    expect(envVarToLogicalKey('SERVER_PORT', mapping)).toBe('value.server.port');
    expect(envVarToLogicalKey('DATABASE_HOST', mapping)).toBe('value.inventory.db.host');
    expect(envVarToLogicalKey('SECRET_INVENTORY_DB_PASSWORD', mapping)).toBe('secret.inventory.db.password');
    expect(envVarToLogicalKey('not-valid', mapping)).toBeUndefined();
  });

  it('resolves the active profile by cli, then env, then manifest default', async () => {
    const root = await createFixtureRoot('version: 1\nproject:\n  name: fixture\nprofiles:\n  default: local\n');
    const manifest = (await loadManifest({ root })).manifest;

    expect(
      resolveActiveProfile(manifest, {
        profile: 'stage',
        processEnv: {
          CNOS_PROFILE: 'prod',
        },
      }),
    ).toEqual({
      profile: 'stage',
      source: 'cli',
    });
    expect(
      resolveActiveProfile(manifest, {
        processEnv: {
          CNOS_PROFILE: 'prod',
        },
      }),
    ).toEqual({
      profile: 'prod',
      source: 'env',
    });
    expect(resolveActiveProfile(manifest)).toEqual({
      profile: 'local',
      source: 'manifest-default',
    });
  });

  it('expands inherited profile activation from profile files', async () => {
    const root = await createFixtureRoot('version: 1\nproject:\n  name: fixture\n');
    const profilesRoot = path.join(root, 'cnos', 'profiles');
    await mkdir(profilesRoot, { recursive: true });
    await writeFile(
      path.join(profilesRoot, 'local.yml'),
      [
        'name: local',
        'extends:',
        '  - base',
        'activate:',
        '  values:',
        '    - base',
        '    - local',
        '  secrets:',
        '    - local',
        '  envFiles:',
        '    - .env',
        '    - .env.local',
      ].join('\n'),
    );

    await expect(
      expandProfileChain('local', {
        manifestRoot: path.join(root, 'cnos'),
        workspace: {
          workspaceId: 'fixture',
          workspaceSource: 'implicit',
          workspaceChain: ['fixture'],
          workspaceRoots: [
            {
              scope: 'local',
              workspaceId: 'fixture',
              path: path.join(root, 'cnos'),
            },
          ],
        },
      }),
    ).resolves.toEqual({
      activeProfile: 'local',
      profiles: ['base', 'local'],
      activation: {
        values: ['values/base', 'values/local'],
        secrets: ['secrets/local'],
        envFiles: ['.env', '.env.local'],
      },
    });
  });

  it('throws on profile inheritance cycles', async () => {
    const root = await createFixtureRoot('version: 1\nproject:\n  name: fixture\n');
    const profilesRoot = path.join(root, 'cnos', 'profiles');
    await mkdir(profilesRoot, { recursive: true });
    await writeFile(path.join(profilesRoot, 'a.yml'), 'name: a\nextends:\n  - b\n');
    await writeFile(path.join(profilesRoot, 'b.yml'), 'name: b\nextends:\n  - a\n');

    await expect(
      expandProfileChain('a', {
        manifestRoot: path.join(root, 'cnos'),
        workspace: {
          workspaceId: 'fixture',
          workspaceSource: 'implicit',
          workspaceChain: ['fixture'],
          workspaceRoots: [
            {
              scope: 'local',
              workspaceId: 'fixture',
              path: path.join(root, 'cnos'),
            },
          ],
        },
      }),
    ).rejects.toThrow('cycle');
  });

  it('loads workspace file and resolves workspace selection and global root precedence', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: fixture',
        'workspaces:',
        '  default: api',
        '  global:',
        '    enabled: true',
        '    root: C:/manifest-global',
        '  items:',
        '    base: {}',
        '    api:',
        '      extends:',
        '        - base',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, '.cnos-workspace.yml'),
      ['workspace: web', 'globalRoot: C:/workspace-file-global'].join('\n'),
    );
    const loadedManifest = await loadManifest({ root });
    const workspaceFile = await loadWorkspaceFile(root);

    expect(workspaceFile?.config).toEqual({
      workspace: 'web',
      globalRoot: 'C:/workspace-file-global',
    });

    const workspace = await resolveWorkspaceContext(loadedManifest.manifest, {
      manifestRoot: loadedManifest.manifestRoot,
      ...(workspaceFile ? { workspaceFile: workspaceFile.config } : {}),
      workspace: 'api',
      globalRoot: 'C:/cli-global',
      processEnv: {
        CNOS_HOME: 'C:/env-global',
      },
    });

    expect(workspace.workspaceId).toBe('api');
    expect(workspace.workspaceSource).toBe('cli');
    expect(workspace.globalRoot).toBe(path.resolve('C:/cli-global'));
    expect(workspace.globalRootSource).toBe('cli');
    expect(workspace.workspaceChain).toEqual(['base', 'api']);
  });

  it('expands workspace inheritance and detects cycles', () => {
    expect(
      expandWorkspaceChain('api', {
        base: {
          extends: [],
        },
        api: {
          extends: ['base'],
        },
      }),
    ).toEqual(['base', 'api']);

    expect(() =>
      expandWorkspaceChain('a', {
        a: {
          extends: ['b'],
        },
        b: {
          extends: ['a'],
        },
      }),
    ).toThrow('cycle');
  });

  it('applies schema defaults and coercion during runtime creation', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: fixture',
        'schema:',
        '  value.server.port:',
        '    type: number',
        '    required: true',
        '  value.server.host:',
        '    type: string',
        '    default: localhost',
      ].join('\n'),
    );
    const loader = createFixtureLoader('seed', [
      {
        key: 'value.server.port',
        value: '8080',
        namespace: 'value',
        sourceId: 'seed',
        pluginId: 'seed',
        workspaceId: 'fixture',
      },
    ]);

    const runtime = await createCnos({
      root,
      plugins: [loader],
    });

    expect(runtime.require('value.server.port')).toBe(8080);
    expect(runtime.require('value.server.host')).toBe('localhost');
  });

  it('reports public safety and env-mapping collisions', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: fixture',
        'envMapping:',
        '  convention: SCREAMING_SNAKE',
        '  explicit:',
        '    DB_PASSWORD: secret.app.token',
        'public:',
        '  promote:',
        '    - secret.app.token',
      ].join('\n'),
    );
    const manifest = (await loadManifest({ root })).manifest;

    expect(validatePublicSafety(manifest)).toEqual([
      expect.objectContaining({
        code: 'public.invalid-promotion',
        key: 'secret.app.token',
      }),
    ]);
    expect(
      validateEnvMappingCollisions(
        {
          ...manifest,
          schema: {
            'value.app-url': {
              type: 'string',
            },
            'value.app_url': {
              type: 'string',
            },
          },
        },
      ),
    ).toEqual([
      expect.objectContaining({
        code: 'env-mapping.collision',
      }),
    ]);
  });

  it('mirrors promoted entries into a readable public namespace', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: fixture',
        'public:',
        '  promote:',
        '    - value.flag.auth.upi_enabled',
        '    - flag.payments.upi_enabled',
        'namespaces:',
        '  flag:',
        '    kind: data',
        '    shareable: true',
      ].join('\n'),
    );
    const runtime = await createCnos({
      root,
      plugins: [
        createFixtureLoader('seed', [
          {
            key: 'value.flag.auth.upi_enabled',
            value: true,
            namespace: 'value',
            sourceId: 'seed',
            pluginId: 'seed',
            workspaceId: 'fixture',
          },
          {
            key: 'flag.payments.upi_enabled',
            value: false,
            namespace: 'flag',
            sourceId: 'seed',
            pluginId: 'seed',
            workspaceId: 'fixture',
          },
        ]),
      ],
    });

    expect(runtime.read('public.flag.auth.upi_enabled')).toBe(true);
    expect(runtime.read('public.flag.payments.upi_enabled')).toBe(false);
  });

  it('fails fast when a sensitive namespace is promoted to public or env', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: fixture',
        'public:',
        '  promote:',
        '    - secret.db.password',
        'envMapping:',
        '  explicit:',
        '    DB_PASSWORD: secret.db.password',
      ].join('\n'),
    );

    await expect(createCnos({ root })).rejects.toThrow('sensitive');
  });

  it('reports workspace safety policy mismatches', async () => {
    const root = await createFixtureRoot(
      [
        'version: 1',
        'project:',
        '  name: fixture',
        'workspaces:',
        '  default: fixture',
        '  global:',
        '    enabled: false',
        '    allowWrite: true',
        '  items:',
        '    fixture: {}',
      ].join('\n'),
    );
    const runtime = await createCnos({
      root,
      plugins: [
        createFixtureLoader('seed', [
          {
            key: 'value.app.name',
            value: 'fixture',
            namespace: 'value',
            sourceId: 'seed',
            pluginId: 'seed',
            workspaceId: 'fixture',
          },
        ]),
      ],
    });

    expect(validateWorkspaceSafety(runtime.manifest, runtime.graph)).toEqual([
      expect.objectContaining({
        code: 'workspace.global-write-policy',
      }),
    ]);
  });

  it('reports schema violations for required, enum, and pattern rules', () => {
    const result = applySchemaRules(
      {
        entries: new Map([
          [
            'value.app.stage',
            {
              key: 'value.app.stage',
              value: 'dev',
              namespace: 'value',
              winner: {
                key: 'value.app.stage',
                value: 'dev',
                namespace: 'value',
                sourceId: 'seed',
                pluginId: 'seed',
                workspaceId: 'fixture',
              },
              overridden: [],
            },
          ],
        ]),
        profile: 'local',
        resolvedAt: '2026-04-03T00:00:00.000Z',
        profileSource: 'manifest-default',
        workspace: {
          workspaceId: 'fixture',
          workspaceSource: 'implicit',
          workspaceChain: ['fixture'],
          workspaceRoots: [],
        },
      },
      {
        'value.app.stage': {
          enum: ['prod'],
        },
        'value.app.name': {
          required: true,
          pattern: '^cnos$',
        },
      },
    );

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'schema.enum', key: 'value.app.stage' }),
        expect.objectContaining({ code: 'schema.required', key: 'value.app.name' }),
      ]),
    );
  });
});
