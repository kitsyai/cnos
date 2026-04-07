import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCnos, defaultPlugins, planDump, writeDump, type LoaderPlugin } from '../src/index.js';

const fixtureRoots: string[] = [];

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cnos-runtime-'));
  const cnosRoot = path.join(root, 'cnos');
  await mkdir(cnosRoot, { recursive: true });
  await writeFile(path.join(cnosRoot, 'cnos.yml'), 'version: 1\nproject:\n  name: cnos-runtime\n');
  fixtureRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('@kitsy/cnos', () => {
  it('wires the official plugins into the runtime', async () => {
    const root = await createFixtureRoot();
    const fixtureLoader: LoaderPlugin = {
      id: 'fixture-loader',
      kind: 'loader',
      async load() {
        return [
          {
            key: 'value.app.name',
            value: 'fixture-app',
            namespace: 'value',
            sourceId: 'fixture-loader',
            pluginId: 'fixture-loader',
            workspaceId: 'cnos-runtime',
          },
        ];
      },
    };
    const runtime = await createCnos({
      root,
      plugins: [fixtureLoader],
    });

    expect(runtime.plugins).toHaveLength(defaultPlugins().length + 1);
    expect(runtime.require('value.app.name')).toBe('fixture-app');
  });

  it('projects env output and materializes deterministic workspace dump snapshots', async () => {
    const root = await createFixtureRoot();
    const dumpRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-dump-'));
    fixtureRoots.push(dumpRoot);
    await writeFile(
      path.join(root, 'cnos', 'cnos.yml'),
      [
        'version: 1',
        'project:',
        '  name: cnos-runtime',
        'workspaces:',
        '  default: api',
        '  items:',
        '    api: {}',
        'envMapping:',
        '  convention: SCREAMING_SNAKE',
        '  explicit:',
        '    API_URL: value.api.baseUrl',
        'public:',
        '  promote:',
        '    - value.api.baseUrl',
        '    - value.app.name',
      ].join('\n'),
    );
    const fixtureLoader: LoaderPlugin = {
      id: 'fixture-exporter',
      kind: 'loader',
      async load() {
        return [
          {
            key: 'value.api.baseUrl',
            value: 'https://api.example.com',
            namespace: 'value',
            sourceId: 'fixture-exporter',
            pluginId: 'fixture-exporter',
            workspaceId: 'api',
          },
          {
            key: 'value.app.name',
            value: 'cnos',
            namespace: 'value',
            sourceId: 'fixture-exporter',
            pluginId: 'fixture-exporter',
            workspaceId: 'api',
          },
          {
            key: 'secret.app.token',
            value: 'secret-token',
            namespace: 'secret',
            sourceId: 'fixture-exporter',
            pluginId: 'fixture-exporter',
            workspaceId: 'api',
          },
        ];
      },
    };

    const runtime = await createCnos({
      root,
      workspace: 'api',
      plugins: [fixtureLoader],
      processEnv: {},
    });

    expect(runtime.toEnv()).toEqual({
      API_URL: 'https://api.example.com',
    });
    expect(runtime.read('public.api.baseUrl')).toBe('https://api.example.com');
    expect(runtime.read('public.app.name')).toBe('cnos');
    expect(runtime.toPublicEnv({ framework: 'vite' })).toEqual({
      VITE_API_BASE_URL: 'https://api.example.com',
      VITE_APP_NAME: 'cnos',
    });

    expect(planDump(runtime.graph)).toEqual({
      workspaceId: 'api',
      profile: 'base',
      flatten: false,
      files: [
        {
          path: 'workspaces/api/secrets/base/app.yml',
          namespace: 'secret',
          content: 'app:\n  token: secret-token\n',
        },
        {
          path: 'workspaces/api/values/base/app.yml',
          namespace: 'value',
          content: 'api:\n  baseUrl: https://api.example.com\napp:\n  name: cnos\n',
        },
      ],
    });
    expect(planDump(runtime.graph, { flatten: true })).toEqual({
      workspaceId: 'api',
      profile: 'base',
      flatten: true,
      files: [
        {
          path: 'secrets/base/app.yml',
          namespace: 'secret',
          content: 'app:\n  token: secret-token\n',
        },
        {
          path: 'values/base/app.yml',
          namespace: 'value',
          content: 'api:\n  baseUrl: https://api.example.com\napp:\n  name: cnos\n',
        },
      ],
    });

    const dumpResult = await writeDump(runtime.graph, {
      to: dumpRoot,
      flatten: true,
    });

    expect(dumpResult.root).toBe(dumpRoot);
    await expect(readFile(path.join(dumpRoot, 'values', 'base', 'app.yml'), 'utf8')).resolves.toBe(
      'api:\n  baseUrl: https://api.example.com\napp:\n  name: cnos\n',
    );
    await expect(readFile(path.join(dumpRoot, 'secrets', 'base', 'app.yml'), 'utf8')).resolves.toBe(
      'app:\n  token: secret-token\n',
    );
  });

  it('resolves filesystem, dotenv, process env, and cli args with spec precedence', async () => {
    const root = await createFixtureRoot();
    await mkdir(path.join(root, 'cnos', 'values', 'base'), { recursive: true });
    await mkdir(path.join(root, 'cnos', 'values', 'local'), { recursive: true });
    await mkdir(path.join(root, 'cnos', 'secrets', 'local'), { recursive: true });
    await mkdir(path.join(root, 'cnos', 'env'), { recursive: true });
    await writeFile(
      path.join(root, 'cnos', 'cnos.yml'),
      [
        'version: 1',
        'project:',
        '  name: cnos-runtime',
        'envMapping:',
        '  convention: SCREAMING_SNAKE',
        '  explicit:',
        '    SERVER_PORT: value.server.port',
        '    DATABASE_HOST: value.inventory.db.host',
        '    SECRET_INVENTORY_DB_PASSWORD: secret.inventory.db.password',
        'resolution:',
        '  precedence:',
        '    - filesystem-values',
        '    - filesystem-secrets',
        '    - dotenv',
        '    - process-env',
        '    - cli-args',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'values', 'base', 'app.yml'),
      ['server:', '  port: 3000', 'inventory:', '  db:', '    host: base-db'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'values', 'local', 'app.yml'),
      ['server:', '  port: 4000'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'secrets', 'local', 'app.yml'),
      ['inventory:', '  db:', '    password: file-secret'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'env', '.env'),
      ['SERVER_PORT=5000', 'DATABASE_HOST=dotenv-db', 'SECRET_INVENTORY_DB_PASSWORD=dotenv-secret'].join('\n'),
    );

    const runtime = await createCnos({
      root,
      processEnv: {
        SERVER_PORT: '6000',
        DATABASE_HOST: 'process-db',
        SECRET_INVENTORY_DB_PASSWORD: 'process-secret',
      },
      cliArgs: ['--value.server.port=7000', '--secret.inventory.db.password=cli-secret'],
    });

    expect(runtime.require('value.server.port')).toBe('7000');
    expect(runtime.require('value.inventory.db.host')).toBe('process-db');
    expect(runtime.require('secret.inventory.db.password')).toBe('cli-secret');
    expect(runtime.inspect('value.server.port')).toMatchObject({
      profile: 'base',
      winner: {
        sourceId: 'cli-args',
        origin: {
          cliArg: '--value.server.port=7000',
        },
      },
      overridden: [
        {
          sourceId: 'filesystem-values',
          value: 3000,
        },
        {
          sourceId: 'filesystem-values',
          value: 4000,
        },
        {
          sourceId: 'dotenv',
          value: '5000',
          origin: {
            envVar: 'SERVER_PORT',
            file: 'cnos/env/.env',
          },
        },
        {
          sourceId: 'process-env',
          value: '6000',
          origin: {
            envVar: 'SERVER_PORT',
          },
        },
      ],
    });
  });

  it('expands inherited profiles and preserves parent-before-child provenance', async () => {
    const root = await createFixtureRoot();
    await mkdir(path.join(root, 'cnos', 'profiles'), { recursive: true });
    await mkdir(path.join(root, 'cnos', 'values', 'base'), { recursive: true });
    await mkdir(path.join(root, 'cnos', 'values', 'stage'), { recursive: true });
    await mkdir(path.join(root, 'cnos', 'secrets', 'stage'), { recursive: true });
    await mkdir(path.join(root, 'cnos', 'env'), { recursive: true });
    await writeFile(
      path.join(root, 'cnos', 'cnos.yml'),
      [
        'version: 1',
        'project:',
        '  name: cnos-runtime',
        'profiles:',
        '  default: local',
        'envMapping:',
        '  convention: SCREAMING_SNAKE',
        '  explicit:',
        '    DATABASE_HOST: value.inventory.db.host',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'profiles', 'stage.yml'),
      [
        'name: stage',
        'extends:',
        '  - base',
        'activate:',
        '  values:',
        '    - base',
        '    - stage',
        '  secrets:',
        '    - stage',
        '  envFiles:',
        '    - .env',
        '    - .env.stage',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'values', 'base', 'app.yml'),
      ['server:', '  port: 3000'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'values', 'stage', 'app.yml'),
      ['server:', '  port: 8080'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'secrets', 'stage', 'app.yml'),
      ['api:', '  token: stage-secret'].join('\n'),
    );
    await writeFile(path.join(root, 'cnos', 'env', '.env'), 'DATABASE_HOST=base-db\n');
    await writeFile(path.join(root, 'cnos', 'env', '.env.stage'), 'DATABASE_HOST=stage-db\n');

    const runtime = await createCnos({
      root,
      processEnv: {
        CNOS_PROFILE: 'stage',
      },
    });

    expect(runtime.meta('profile')).toBe('stage');
    expect(runtime.meta('resolved.from')).toBe('env');
    expect(runtime.require('value.server.port')).toBe(8080);
    expect(runtime.require('value.inventory.db.host')).toBe('stage-db');
    expect(runtime.require('secret.api.token')).toBe('stage-secret');
    expect(runtime.inspect('value.server.port')).toMatchObject({
      profile: 'stage',
      profileSource: 'env',
      winner: {
        sourceId: 'filesystem-values',
        origin: {
          file: 'cnos/values/stage/app.yml',
        },
      },
      overridden: [
        {
          sourceId: 'filesystem-values',
          value: 3000,
          origin: {
            file: 'cnos/values/base/app.yml',
          },
        },
      ],
    });
  });

  it('layers global and local workspace roots with local child winning last', async () => {
    const root = await createFixtureRoot();
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), 'cnos-global-'));
    fixtureRoots.push(globalRoot);
    await mkdir(path.join(root, 'cnos', 'workspaces', 'base', 'values', 'base'), { recursive: true });
    await mkdir(path.join(root, 'cnos', 'workspaces', 'api', 'values', 'local'), { recursive: true });
    await mkdir(path.join(globalRoot, 'workspaces', 'base', 'values', 'base'), { recursive: true });
    await mkdir(path.join(globalRoot, 'workspaces', 'api', 'values', 'local'), { recursive: true });
    await writeFile(
      path.join(root, 'cnos', 'cnos.yml'),
      [
        'version: 1',
        'project:',
        '  name: cnos-runtime',
        'workspaces:',
        '  default: api',
        '  global:',
        '    enabled: true',
        '  items:',
        '    base: {}',
        '    api:',
        '      extends:',
        '        - base',
      ].join('\n'),
    );
    await writeFile(
      path.join(globalRoot, 'workspaces', 'base', 'values', 'base', 'app.yml'),
      ['server:', '  host: global-base'].join('\n'),
    );
    await writeFile(
      path.join(globalRoot, 'workspaces', 'api', 'values', 'local', 'app.yml'),
      ['server:', '  host: global-api'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'workspaces', 'base', 'values', 'base', 'app.yml'),
      ['server:', '  host: local-base'].join('\n'),
    );
    await writeFile(
      path.join(root, 'cnos', 'workspaces', 'api', 'values', 'local', 'app.yml'),
      ['server:', '  host: local-api'].join('\n'),
    );

    const runtime = await createCnos({
      root,
      workspace: 'api',
      globalRoot,
    });

    expect(runtime.meta('workspace')).toBe('api');
    expect(runtime.meta('global.enabled')).toBe(true);
    expect(runtime.require('value.server.host')).toBe('local-api');
    expect(runtime.inspect('value.server.host')).toMatchObject({
      workspace: {
        id: 'api',
        chain: ['base', 'api'],
      },
      winner: {
        workspaceId: 'api',
        origin: {
          file: 'cnos/workspaces/api/values/local/app.yml',
        },
      },
      overridden: [
        {
          workspaceId: 'base',
          origin: {
            file: expect.stringContaining('cnos-global-'),
          },
        },
        {
          workspaceId: 'api',
          origin: {
            file: expect.stringContaining('cnos-global-'),
          },
        },
        {
          workspaceId: 'base',
          origin: {
            file: 'cnos/workspaces/base/values/base/app.yml',
          },
        },
      ],
    });
  });
});
