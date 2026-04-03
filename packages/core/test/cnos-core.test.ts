import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCnos,
  envVarToLogicalKey,
  expandProfileChain,
  expandWorkspaceChain,
  flattenObject,
  loadManifest,
  loadWorkspaceFile,
  logicalKeyToEnvVar,
  resolveWorkspaceContext,
  resolveActiveProfile,
  type ConfigEntry,
  type LoaderPlugin,
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
    expect(loadedManifest.manifest.profiles.default).toBe('local');
    expect(loadedManifest.manifest.plugins.resolver).toBe('profile-aware');
  });

  it('rejects invalid manifests with a clear error', async () => {
    const root = await createFixtureRoot('version: 1\nproject: {}\n');

    await expect(loadManifest({ root })).rejects.toThrow('project.name');
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
    expect(runtime.meta('profile')).toBe('local');
    expect(runtime.meta('resolved.from')).toBe('manifest-default');
    expect(runtime.meta('cnos.version')).toBeTruthy();
    expect(runtime.inspect('value.app.config').winner.sourceId).toBe('seed-override');
    expect(runtime.toNamespace('meta')).toMatchObject({
      profile: 'local',
      resolved: {
        from: 'manifest-default',
      },
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
          workspaceSource: 'project-name',
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
        values: ['base', 'local'],
        secrets: ['local'],
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
          workspaceSource: 'project-name',
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
});
