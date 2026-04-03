import { normalizeManifest, type ResolvedGraph, type WorkspaceContext } from '@kitsy/cnos-core';
import { describe, expect, it } from 'vitest';

import { createBasicSchemaPlugin } from '../src/index.js';

function createWorkspaceContext(): WorkspaceContext {
  return {
    workspaceId: 'fixture',
    workspaceSource: 'project-name',
    workspaceChain: ['fixture'],
    workspaceRoots: [],
  };
}

function createGraph(): ResolvedGraph {
  return {
    entries: new Map([
      [
        'value.server.port',
        {
          key: 'value.server.port',
          value: 'not-a-number',
          namespace: 'value',
          winner: {
            key: 'value.server.port',
            value: 'not-a-number',
            namespace: 'value',
            sourceId: 'fixture',
            pluginId: 'fixture',
            workspaceId: 'fixture',
          },
          overridden: [],
        },
      ],
    ]),
    profile: 'local',
    resolvedAt: '2026-04-03T00:00:00.000Z',
    profileSource: 'manifest-default',
    workspace: createWorkspaceContext(),
  };
}

describe('@kitsy/cnos-plugin-basic-schema', () => {
  it('creates a named plugin', () => {
    expect(createBasicSchemaPlugin().id).toBe('basic-schema');
  });

  it('validates schema issues against the resolved graph', async () => {
    const plugin = createBasicSchemaPlugin();
    const manifest = normalizeManifest({
      version: 1,
      project: {
        name: 'fixture',
      },
      schema: {
        'value.server.port': {
          type: 'number',
        },
        'value.server.host': {
          required: true,
        },
      },
    });

    await expect(
      plugin.validate(createGraph(), {
        manifest,
        schema: manifest.schema,
      }),
    ).resolves.toMatchObject({
      pluginId: 'basic-schema',
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'schema.type', key: 'value.server.port' }),
        expect.objectContaining({ code: 'schema.required', key: 'value.server.host' }),
      ]),
    });
  });
});
