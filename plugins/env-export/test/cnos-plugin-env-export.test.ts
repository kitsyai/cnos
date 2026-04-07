import {
  normalizeManifest,
  promoteToPublic,
  type ConfigEntry,
  type ExportContext,
  type NormalizedManifest,
  type ResolvedGraph,
  type WorkspaceContext,
} from '@kitsy/cnos-core';
import { describe, expect, it } from 'vitest';

import { createEnvExportPlugin, createPublicEnvExportPlugin, toEnv, toPublicEnv } from '../src/index.js';

function createWorkspaceContext(): WorkspaceContext {
  return {
    workspaceId: 'api',
    workspaceSource: 'manifest-default',
    workspaceChain: ['api'],
    workspaceRoots: [
      {
        scope: 'local',
        workspaceId: 'api',
        path: '/repo/cnos/workspaces/api',
      },
    ],
  };
}

function createEntry(
  key: string,
  value: unknown,
  namespace: ConfigEntry['namespace'],
): ConfigEntry {
  return {
    key,
    value,
    namespace,
    sourceId: 'fixture',
    pluginId: 'fixture',
    workspaceId: 'api',
  };
}

function createGraph(entries: ConfigEntry[]): ResolvedGraph {
  return {
    entries: new Map(
      entries.map((entry) => [
        entry.key,
        {
          key: entry.key,
          value: entry.value,
          namespace: entry.namespace,
          winner: entry,
          overridden: [],
        },
      ]),
    ),
    profile: 'local',
    resolvedAt: '2026-04-03T00:00:00.000Z',
    profileSource: 'manifest-default',
    workspace: createWorkspaceContext(),
  };
}

function createManifest(overrides: {
  envMapping?: NormalizedManifest['envMapping'];
  promote?: string[];
  frameworks?: Record<string, string>;
} = {}): NormalizedManifest {
  return normalizeManifest({
    version: 1,
    project: {
      name: 'fixture',
    },
    ...(overrides.envMapping
      ? {
          envMapping: overrides.envMapping,
        }
      : {}),
    public: {
      ...(overrides.promote
        ? {
            promote: overrides.promote,
          }
        : {}),
      ...(overrides.frameworks
        ? {
            frameworks: overrides.frameworks,
          }
        : {}),
    },
  });
}

function createExportContext(manifest: NormalizedManifest): ExportContext {
  return {
    manifest,
    promotions: manifest.public.promote,
    frameworkPrefixes: Object.values(manifest.public.frameworks),
    workspace: createWorkspaceContext(),
  };
}

describe('@kitsy/cnos-plugin-env-export', () => {
  it('creates the expected exporter ids', () => {
    expect(createEnvExportPlugin().id).toBe('@kitsy/cnos/plugins/env-export');
    expect(createPublicEnvExportPlugin().id).toBe('@kitsy/cnos/plugins/public-env-export');
  });

  it('projects only explicit env mappings and skips meta keys', () => {
    const manifest = createManifest({
      envMapping: {
        convention: 'SCREAMING_SNAKE',
        explicit: {
          DATABASE_HOST: 'value.inventory.db.host',
        },
      },
    });
    const graph = createGraph([
      createEntry('meta.profile', 'local', 'meta'),
      createEntry('secret.app.token', 'secret-token', 'secret'),
      createEntry('value.app.name', 'cnos', 'value'),
      createEntry('value.inventory.db.host', 'db.internal', 'value'),
    ]);

    expect(toEnv(graph, manifest)).toEqual({
      DATABASE_HOST: 'db.internal',
    });
  });

  it('projects only promoted value keys with framework and custom prefixes', () => {
    const manifest = createManifest({
      envMapping: {
        convention: 'SCREAMING_SNAKE',
        explicit: {
          API_URL: 'value.api.baseUrl',
        },
      },
      promote: ['value.api.baseUrl', 'value.app.name'],
    });
    const graph = createGraph([
      createEntry('value.app.name', 'cnos', 'value'),
      createEntry('value.api.baseUrl', 'https://api.example.com', 'value'),
      createEntry('secret.app.token', 'secret-token', 'secret'),
    ]);
    const promotedGraph = promoteToPublic(graph, manifest);

    expect(toPublicEnv(promotedGraph, manifest, { framework: 'next' })).toEqual({
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com',
      NEXT_PUBLIC_APP_NAME: 'cnos',
    });
    expect(toPublicEnv(promotedGraph, manifest, { prefix: 'PUBLIC_' })).toEqual({
      PUBLIC_API_BASE_URL: 'https://api.example.com',
      PUBLIC_APP_NAME: 'cnos',
    });
  });

  it('rejects any secret promotion', () => {
    const manifest = createManifest({
      promote: ['value.app.name', 'secret.app.token'],
    });
    const graph = createGraph([
      createEntry('value.app.name', 'cnos', 'value'),
      createEntry('secret.app.token', 'secret-token', 'secret'),
    ]);

    expect(() => promoteToPublic(graph, manifest)).toThrow('sensitive');
  });

  it('backs exporter plugins with the shared projection helpers', async () => {
    const manifest = createManifest({
      envMapping: {
        convention: 'SCREAMING_SNAKE',
        explicit: {
          API_URL: 'value.api.baseUrl',
        },
      },
      promote: ['value.api.baseUrl'],
    });
    const graph = promoteToPublic(
      createGraph([createEntry('value.api.baseUrl', 'https://api.example.com', 'value')]),
      manifest,
    );
    const context = createExportContext(manifest);

    await expect(createEnvExportPlugin().export(graph, context)).resolves.toEqual({
      pluginId: '@kitsy/cnos/plugins/env-export',
      value: {
        API_URL: 'https://api.example.com',
      },
    });
    await expect(createPublicEnvExportPlugin().export(graph, context)).resolves.toEqual({
      pluginId: '@kitsy/cnos/plugins/public-env-export',
      value: {
        API_BASE_URL: 'https://api.example.com',
      },
    });
  });

  it('skips unresolved local secret refs from env export', () => {
    const manifest = createManifest({
      envMapping: {
        explicit: {
          APP_TOKEN: 'secret.app.token',
        },
      },
    });
    const graph = createGraph([
      createEntry(
        'secret.app.token',
        {
          provider: 'local',
          vault: 'default',
          ref: 'app.token',
        },
        'secret',
      ),
    ]);

    expect(toEnv(graph, manifest)).toEqual({});
  });
});
